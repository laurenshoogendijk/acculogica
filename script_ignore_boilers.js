// ─── Configuratie ────────────────────────────────────────────────────────────
const CONFIG = {
    deviceId: "f9fc32975ef6c36e7156469270b525df",
    maxCharge: -2500,  // W, negatief = laden
    maxDischarge: 2500,  // W, positief = ontladen

    maxSOC: 100,
    minSOC: 12,
    deadband: 5,

    rampUp: 350, // Setpoint verhogen / verlagen in stappen van rampUp Watt
};
// ─────────────────────────────────────────────────────────────────────────────

function safeNumber(value, fallback = 0) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : fallback;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function normalizeInput(msg) {
    const data = (msg && msg.data) ? msg.data : {};
    const pvHuis = safeNumber(data.pvhuisvermogen, 0);
    const pvSchuur = safeNumber(data.pvschuurvermogen, 0);

    return {
        p1_hw: safeNumber(data.p1_hw, 0),
        b1vermogen: safeNumber(data.b1vermogen, 0),
        b2vermogen: safeNumber(data.b2vermogen, 0),
        accu_nu: safeNumber(data.accu_nu, 0),
        pvhuisvermogen: Math.abs(pvHuis),
        pvschuurvermogen: Math.abs(pvSchuur),
        soc: clamp(safeNumber(data.soc, 0), 0, 100),
    };
}

function determineSetpoint(input) {
    const soc = input.soc;
    const b1 = input.b1vermogen;
    const b2 = input.b2vermogen;
    const accuNu = -(input.accu_nu || 0);
    const p1 = input.p1_hw || 0;
    const pvT = Math.round((input.pvhuisvermogen || 0) + (input.pvschuurvermogen || 0));
    const boilerTotal = Math.round(b1 + b2);
    const liveDemand = Math.max(0, Math.round(p1)) + boilerTotal;
    const nonBoilerLoad = Math.max(0, Math.round(p1 - boilerTotal));
    const exportPower = Math.max(0, Math.round(-p1));
    const pvSurplus = Math.max(0, Math.round(pvT - nonBoilerLoad));
    const chargeAvailableFromPv = Math.max(0, Math.round(pvT - liveDemand));

    let huisverbruik = Math.round(p1 + accuNu - b1 - b2 - pvT);
    let doelSetpoint = 0;
    let reden = 'Balans';
    let stop = false;

    if (!Number.isFinite(p1) || !Number.isFinite(b1) || !Number.isFinite(b2)) {
        return {
            setpoint: 0,
            reason: 'Sensor data ontbreekt',
            stop: true,
            huisverbruik,
            pvT,
            accuNu,
            soc,
            boilerTotal,
        };
    }

    if (p1 <= 0) {
        if (boilerTotal > 0 && chargeAvailableFromPv <= 0) {
            doelSetpoint = 0;
            stop = true;
            reden = 'Boiler start: batterij direct 0 W, geen ramp-down';
        } else if (chargeAvailableFromPv <= 0) {
            doelSetpoint = 0;
            reden = 'Laden geblokkeerd: geen PV-overschot';
        } else {
            const chargeFromSolar = Math.min(chargeAvailableFromPv, Math.abs(CONFIG.maxCharge));
            doelSetpoint = -chargeFromSolar;
            reden = `Accu laden (${doelSetpoint} W)`;
        }
    } else if (p1 > 0) {
        if (boilerTotal > 0) {
            const boilerStartupSpike = nonBoilerLoad < boilerTotal;
            if (boilerStartupSpike) {
                doelSetpoint = 0;
                stop = true;
                reden = 'Boiler start: batterij direct 0 W, geen ramp-down';
            } else if (pvT > 0) {
                const solarToCharge = Math.max(0, Math.min(pvSurplus, Math.abs(CONFIG.maxCharge)));
                doelSetpoint = -solarToCharge;
                reden = `Boilers actief; PV overschot wordt geladen (${Math.abs(doelSetpoint)}W)`;
            } else {
                const batterySupportForHouse = Math.min(nonBoilerLoad, CONFIG.maxDischarge);
                doelSetpoint = batterySupportForHouse;
                reden = `Boilers actief; batterij ondersteunt alleen huishoudelijk verbruik buiten boilers (${doelSetpoint}W)`;
            }
        } else {
            doelSetpoint = Math.min(p1, CONFIG.maxDischarge);
            reden = `Accu ontladen (${doelSetpoint}W)`;
        }
    }

    if (soc >= CONFIG.maxSOC && doelSetpoint < 0) {
        reden = 'Accu vol';
        doelSetpoint = 0;
    }

    if (soc <= CONFIG.minSOC && doelSetpoint > 0) {
        reden = 'Accu leeg';
        doelSetpoint = 0;
    }

    if (soc >= CONFIG.maxSOC && doelSetpoint === 0 && chargeAvailableFromPv > 0) {
        reden = 'Accu vol';
    }

    if (Math.abs(p1) <= CONFIG.deadband && pvT <= 0) {
        doelSetpoint = 0;
        reden = 'Meter binnen deadband; houden op 0 W';
    }

    doelSetpoint = Math.max(CONFIG.maxCharge, Math.min(CONFIG.maxDischarge, doelSetpoint));

    const verschil = Math.round(Math.abs(doelSetpoint - accuNu));
    if (verschil < CONFIG.deadband && soc > CONFIG.minSOC && soc < CONFIG.maxSOC) {
        stop = true;
    }

    let setpoint;
    if (!stop) {
        if (doelSetpoint > accuNu) {
            setpoint = Math.min(doelSetpoint, accuNu + CONFIG.rampUp);
        } else if (doelSetpoint < accuNu) {
            setpoint = Math.max(doelSetpoint, accuNu - CONFIG.rampUp);
        } else {
            setpoint = doelSetpoint;
        }

        if (setpoint !== doelSetpoint) {
            reden += ` [ramp: ${Math.round(accuNu)}→${setpoint} (doel: ${doelSetpoint})]`;
        }
    } else {
        setpoint = accuNu;
    }

    return {
        setpoint,
        reason: reden,
        stop,
        huisverbruik,
        pvT,
        accuNu,
        soc,
        boilerTotal,
        nonBoilerLoad,
        pvSurplus,
        exportPower,
    };
}

function controller(node, msg) {
    const input = normalizeInput(msg);

    if (isNaN(input.p1_hw) || isNaN(input.b1vermogen) || isNaN(input.b2vermogen)) {
        if (node && node.status) {
            node.status({ fill: 'red', shape: 'ring', text: 'Sensor data ontbreekt' });
        }
        return null;
    }

    const decision = determineSetpoint(input);
    const kleur = decision.setpoint > 0 ? 'green' : decision.setpoint < 0 ? 'blue' : 'grey';
    if (node && node.status) {
        node.status({
            fill: kleur,
            shape: 'dot',
            text: `Huisverbruik: ${decision.huisverbruik}, p1: ${Math.round(input.p1_hw)}W | b1: ${Math.round(input.b1vermogen)}W | b2: ${Math.round(input.b2vermogen)}W | accu: ${Math.round(decision.accuNu)}W | SoC: ${decision.soc}% | → ${decision.setpoint}W (${decision.reason})`
        });
    }

    const msgPayload = {
        payload2: {
            data: {
                device_id: CONFIG.deviceId,
                time_num: 0,
                start_time: '00:00',
                end_time: '23:59',
                days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
                power: decision.setpoint,
            }
        }
    };

    const msgStatus = {
        payload: {
            value: decision.reason
        }
    };

    if (decision.stop) {
        return [null, msgStatus];
    }

    return [msgPayload, msgStatus];
}

if (typeof module !== 'undefined') {
    module.exports = {
        CONFIG,
        safeNumber,
        clamp,
        normalizeInput,
        determineSetpoint,
        controller,
    };
}

if (typeof module === 'undefined' && typeof node !== 'undefined' && typeof msg !== 'undefined') {
    return controller(node, msg);
}