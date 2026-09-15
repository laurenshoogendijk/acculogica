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

const d = msg.data;
const soc = parseFloat(d.soc) || 0;
const b1 = parseFloat(d.b1vermogen) || 0;
const b2 = parseFloat(d.b2vermogen) || 0;
const accuNu = -(parseFloat(d.accu_nu) || 0);
const p1 = parseFloat(d.p1_hw) || 0;
const pvH = parseFloat(d.pvhuisvermogen) || 0;
const pvS = parseFloat(d.pvschuurvermogen) || 0;
const pvT = Math.round(pvH + pvS);
const boilerTotal = Math.round(b1 + b2);

// Validatie
if (isNaN(parseFloat(d.p1_hw)) || isNaN(parseFloat(d.b1vermogen)) || isNaN(parseFloat(d.b2vermogen))) {
    node.status({ fill: "red", shape: "ring", text: "Sensor data ontbreekt" });
    return null;
}

let huisverbruik = Math.round(p1 + accuNu - b1 - b2 - pvT);
//let huisverbruik = Math.round(p1 + accuNu - b1 - b2 + pvT);
let doelSetpoint = Math.round(p1 + accuNu);
doelSetpoint = Math.max(CONFIG.maxCharge, Math.min(CONFIG.maxDischarge, doelSetpoint));

let reden = "";
let stop = false;

if (doelSetpoint < 0) {
    reden = `Accu laden (${doelSetpoint} W)`;
} else if (doelSetpoint > 0) {
    if (boilerTotal > 0) {
        doelSetpoint = Math.min(Math.round(huisverbruik), (Math.max(Math.round(p1), 0)));
        reden = `Boilers staan aan, huisverbruik (${doelSetpoint}W) afdekken`;
    } else {
        reden = `Accu ontladen (${doelSetpoint}W)`;
    }
} else {
    reden = `Balans`;
}

// ─── SoC-grenzen ─────────────────────────────────────────────────────────────
if (soc >= CONFIG.maxSOC && doelSetpoint < 0) {
    reden = "Accu vol";
    doelSetpoint = 0;
}

if (soc <= CONFIG.minSOC && doelSetpoint > 0) {
    reden = "Accu leeg";
    doelSetpoint = 0;
}

// ─── Clamp naar limieten ─────────────────────────────────────────────────────
doelSetpoint = Math.max(CONFIG.maxCharge, Math.min(CONFIG.maxDischarge, doelSetpoint));

// ─── Deadband-check op doelSetpoint vs huidig accuvermogen ───────────────────
//const verschil = Math.round(Math.abs(accuNu + doelSetpoint));
const verschil = Math.round(Math.abs(doelSetpoint - accuNu));
if (verschil < CONFIG.deadband && soc > CONFIG.minSOC && soc < CONFIG.maxSOC) {
    stop = true;
}

// Laden maar PV < 10?
if (doelSetpoint < 0 && pvT > -10) {
    //stop = true;
    reden = `Accu wil laden maar er komt niks meer uit de PV ${pvT}.`
}

// ─── Ramp-up: stap vanuit huidig accuvermogen richting doel ──────────────────
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

// ─── Status ──────────────────────────────────────────────────────────────────
const kleur = setpoint > 0 ? "green" : setpoint < 0 ? "blue" : "grey";
node.status({
    fill: kleur,
    shape: "dot",
    text: `Huisverbruik: ${huisverbruik}, p1: ${Math.round(p1)}W | b1: ${Math.round(b1)}W | b2: ${Math.round(b2)}W | accu: ${Math.round(accuNu)}W | SoC: ${soc}% | → ${setpoint}W (${reden})`
});

const msgPayload = {
    payload2: {
        data: {
            device_id: CONFIG.deviceId,
            time_num: 0,
            start_time: "00:00",
            end_time: "23:59",
            days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
            power: setpoint,
        }
    }
};

const msgStatus = {
    payload: {
        value: reden
    }
};

if (stop) {
    return [null, msgStatus];
} else {
    return [msgPayload, msgStatus];
}