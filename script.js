// ─── Configuratie en regels van de batterijcontroller ──────────────────────
// Deze waarden bepalen hoe de accu wordt geladen, ontladen en gestuurd op basis van
// PV-opbrengst, huisverbruik, prijssturing en veiligheidsdrempels.
const CONFIG = {
    deviceId: "31c393bc5ba6bd424490fb39a18c9a72",

    maxLaadVermogen: -2500,
    maxOntlaadVermogen: 1250,
    minLaadVermogenDrempel: -100,
    minOntlaadVermogenDrempel: 50,

    minSoc: 12,
    maxSoc: 100,
    deadband: 15,
    rampUpStap: 350,

    ladenOpPvOverschot: true,

    forceerLadenMaxSoc: 90,
    forceerOntladenMinSoc: 25,

    prijsSturingActief: true,
    minPrijsSpreadOntladen: 0.12,
    minPrijsSpreadLaden: 0.08,
    prijsLadenVerschil: 0.04,
    minSocPrijsOntladen: 60,

    accuEfficiency: 0.85,
    degradatieKosten: 0.02,

    negatievePrijsBanden: [
        { maxVerschil: 0.05, vermogen: -2500 },
        { maxVerschil: 0.10, vermogen: -2000 },
        { maxVerschil: 0.25, vermogen: -1500 },
        { maxVerschil: Infinity, vermogen: -1000 }
    ]
};

// Zet invoerwaarden veilig om naar getallen. Als een sensor ontbreekt of ongeldige data
// bevat, wordt een fallback gebruikt zodat de controller niet crasht.
function safeNumber(value, fallback = 0) {
    const valueAsNumber = Number(value);
    return Number.isFinite(valueAsNumber) ? valueAsNumber : fallback;
}

// Houd een waarde binnen een minimum en maximum. Dit voorkomt dat de controller
// onrealistische of gevaarlijke vermogenswaarden stuurt.
function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

// Vergelijk prijzen met een kleine tolerantie. Hierdoor worden kleine floating-point
// verschillen niet als een echte prijswijziging gezien.
function isPriceApproximatelyEqual(a, b, tolerance = 0.0005) {
    return Math.abs(a - b) <= tolerance;
}

// Normaliseer de binnenkomende Home Assistant / Node-RED data naar één vaste vorm.
// Hierdoor kunnen alle volgende regels werken met consistente namen en een veilige default.
function normalizeInput(msg) {
    const data = (msg && msg.data) ? msg.data : {};

    return {
        p1c: safeNumber(data.p1c, 0),
        p1p: safeNumber(data.p1p, 0),
        p1: safeNumber(data.p1, 0),
        accu: safeNumber(data.accu, 0),
        pv: safeNumber(data.pv, 0),
        soc: clamp(safeNumber(data.soc, 0), 0, 100),
        target: safeNumber(data.target, 0),
        prijs: safeNumber(data.prijs, 0),
        laagsteprijs: safeNumber(data.laagsteprijs, 0),
        hoogsteprijs: safeNumber(data.hoogsteprijs, 0),
        forceCharge: String(data.force_charge || '').toLowerCase() === 'on',
        forceDischarge: String(data.force_discharge || '').toLowerCase() === 'on'
    };
}

// Bepaal het werkelijke streefvermogen voor de batterij.
// De logica is opgebouwd als een reeks prioriteiten:
// 1) ontbrekende sensoren -> stop
// 2) handmatig forceren
// 3) prijssturing
// 4) veiligheidsdrempels en rendement
// 5) ramping / stapgrootte van het uiteindelijke vermogen
function determineSetpoint(input) {
    // p1 is het totale net-/huisvermogen. De controller werkt met positief/negatief
    // signaal dat aangeeft of er wordt geladen of ontladen vanuit/naar het netwerk.
    const p1Vermogen = (input.p1c * 1000) - (input.p1p * 1000);
    const accuVermogen = -input.accu;
    const pvVermogen = input.pv;
    const soc = input.soc;
    const meterDoel = input.target;
    const huidigePrijs = input.prijs;
    const laagstePrijs = input.laagsteprijs;
    const hoogstePrijs = input.hoogsteprijs;
    const prijsVerschil = hoogstePrijs - laagstePrijs;
    const breakEvenOntlaadPrijs = (laagstePrijs / CONFIG.accuEfficiency) + CONFIG.degradatieKosten;
    const huisVerbruik = Math.round(Math.abs(p1Vermogen + accuVermogen + pvVermogen));

    // Basisdoel: compenseer het huidige huishouden met het vermogen van de accu.
    // Dit is het startpunt waarop later prijsregels en veiligheidscontroles kunnen ingrijpen.
    let doelSetpoint = Math.round(p1Vermogen + accuVermogen - meterDoel);
    let reden = '';
    let stop = false;

    // Als de basisgegevens ontbreken, stop direct met een duidelijke foutstatus.
    if (!Number.isFinite(p1Vermogen) || (!Number.isFinite(input.p1c) && !Number.isFinite(input.p1))) {
        return {
            setpoint: 0,
            reason: 'Sensor data ontbreekt',
            stop: true,
            huisVerbruik,
            p1Vermogen,
            accuVermogen,
            soc,
            pvVermogen
        };
    }

    // Eerst: als het exportvermogen negatief is (er wordt dus energie geladen), gebruik de
    // PV-overschotregel. Anders wordt het huishouden met de accu bijgestuurd.
    if (doelSetpoint < 0) {
        if (CONFIG.ladenOpPvOverschot) {
            reden = `Laden op PV-overschot (${Math.abs(doelSetpoint)} W)`;
        } else {
            doelSetpoint = 0;
            reden = 'PV-overschot, voorkeur voor teruglevering';
        }
    } else if (doelSetpoint > 0) {
        reden = `Eigen verbruik dekken (${doelSetpoint} W)`;
    }

    // Handmatige overrides hebben prioriteit boven de normale prijslogica.
    if (input.forceCharge && soc < CONFIG.forceerLadenMaxSoc) {
        doelSetpoint = CONFIG.maxLaadVermogen;
        reden = 'Handmatig laden geforceerd';
    } else if (input.forceDischarge && soc > CONFIG.forceerOntladenMinSoc) {
        doelSetpoint = CONFIG.maxOntlaadVermogen;
        reden = 'Handmatig ontladen geforceerd';
    } else if (CONFIG.prijsSturingActief) {
        if (huidigePrijs < 0) {
            if (isPriceApproximatelyEqual(huidigePrijs, laagstePrijs)) {
                doelSetpoint = CONFIG.maxLaadVermogen;
                reden = `Laagste prijs is negatief (€${huidigePrijs.toFixed(4)}), maximaal laden`;
            } else {
                const verschilMetLaagste = Math.abs(huidigePrijs - laagstePrijs);
                const band = CONFIG.negatievePrijsBanden.find(b => verschilMetLaagste <= b.maxVerschil);
                doelSetpoint = band ? band.vermogen : CONFIG.maxLaadVermogen;
                reden = `Negatieve prijs (€${huidigePrijs.toFixed(4)}), laden op ${Math.abs(doelSetpoint)} W`;
            }
        } else if (
            huidigePrijs >= (hoogstePrijs - 0.03) &&
            prijsVerschil >= CONFIG.minPrijsSpreadOntladen &&
            soc > CONFIG.minSocPrijsOntladen
        ) {
            doelSetpoint = CONFIG.maxOntlaadVermogen;
            reden = `Piek-uur (€${huidigePrijs.toFixed(4)}), spread €${prijsVerschil.toFixed(3)} — max ontladen naar net`;
        } else if (
            isPriceApproximatelyEqual(huidigePrijs, laagstePrijs) &&
            prijsVerschil >= CONFIG.minPrijsSpreadLaden &&
            soc < CONFIG.maxSoc
        ) {
            doelSetpoint = CONFIG.maxLaadVermogen;
            reden = `Goedkoopste uur van de dag (€${huidigePrijs.toFixed(4)}), maximaal laden`;
        } else if (
            huidigePrijs <= (laagstePrijs + CONFIG.prijsLadenVerschil) &&
            prijsVerschil >= CONFIG.minPrijsSpreadLaden &&
            soc < CONFIG.maxSoc
        ) {
            doelSetpoint = CONFIG.maxLaadVermogen;
            reden = `Voordelig tarief (€${huidigePrijs.toFixed(4)}), bijladen uit het net`;
        }
    }

    // De break-even controle voorkomt dat de accu wordt ontladen als de stroomprijs lager is
    // dan de werkelijke kostprijs van het ontladen (incl. efficiëntie en degradatie).
    if (doelSetpoint > 0 && huidigePrijs < breakEvenOntlaadPrijs) {
        doelSetpoint = 0;
        reden = `Ontladen geblokkeerd: netprijs (€${huidigePrijs.toFixed(3)}) is goedkoper dan accustroom (break-even €${breakEvenOntlaadPrijs.toFixed(3)})`;
    }

    // Onder deze drempels is laden/ontladen niet efficiënt genoeg en wordt het geblokkeerd.
    if (doelSetpoint < 0 && doelSetpoint > CONFIG.minLaadVermogenDrempel) {
        doelSetpoint = 0;
        reden = 'Laadvermogen te laag voor efficiënt rendement';
    }
    if (doelSetpoint > 0 && doelSetpoint < CONFIG.minOntlaadVermogenDrempel && pvVermogen < 200) {
        doelSetpoint = 0;
        reden = 'Ontlaadvermogen te laag voor efficiënt rendement';
    }

    // Bescherm de accu tegen een te hoge of te lage toestand.
    if (soc >= CONFIG.maxSoc && doelSetpoint < 0) {
        doelSetpoint = 0;
        reden = `Accu is vol (${soc}%)`;
    }
    if (soc <= CONFIG.minSoc && doelSetpoint > 0) {
        doelSetpoint = 0;
        reden = `Accu is leeg (${soc}%)`;
    }

    // Als het verschil klein is en de accu zich niet in een uiterste toestand bevindt,
    // worden extra commando's onderdrukt om te voorkomen dat de batterij heen en weer springt.
    const vermogensVerschil = Math.abs(accuVermogen - doelSetpoint);
    if (vermogensVerschil < CONFIG.deadband && soc > CONFIG.minSoc && soc < CONFIG.maxSoc) {
        stop = true;
    }

    // Houd de opdracht binnen het technisch toegestane bereik van de batterij.
    doelSetpoint = clamp(doelSetpoint, CONFIG.maxLaadVermogen, CONFIG.maxOntlaadVermogen);

    // Ramping: het uiteindelijke vermogenssignaal mag niet in één grote stap springen.
    // Hierdoor wordt het batterijvermogen geleidelijk bijgesteld.
    let setpoint = doelSetpoint;
    if (!stop) {
        if (doelSetpoint > accuVermogen) {
            setpoint = Math.min(doelSetpoint, accuVermogen + CONFIG.rampUpStap);
        } else if (doelSetpoint < accuVermogen) {
            setpoint = Math.max(doelSetpoint, accuVermogen - CONFIG.rampUpStap);
        }

        if (setpoint < 0) reden = reden || `Accu laden (${setpoint} W)`;
        else if (setpoint > 0) reden = reden || `Accu ontladen (${setpoint} W)`;
        else reden = reden || 'Balans bereikt';

        if (setpoint !== doelSetpoint) {
            reden += ` [ramp: ${Math.round(accuVermogen)}→${Math.round(setpoint)} W (doel: ${doelSetpoint} W)]`;
        }
    } else {
        setpoint = accuVermogen;
    }

    if (setpoint === 0 && Math.abs(accuVermogen) <= 10) {
        stop = true;
    }

    return {
        setpoint,
        reason: reden,
        stop,
        huisVerbruik,
        p1Vermogen,
        accuVermogen,
        soc,
        pvVermogen
    };
}

// Hoofdbesturingsfunctie: verwerkt de inkomende Node-RED-berichten en retourneert het
// verplichte response-patroon [payload, status].
function controller(node, msg) {
    const input = normalizeInput(msg);

    // Als beide meterwaarden ontbreken, is er geen bruikbare energiedata; stop netjes.
    if (isNaN(parseFloat(input.p1c)) && isNaN(parseFloat(input.p1))) {
        if (node && node.status) {
            node.status({ fill: 'red', shape: 'ring', text: 'Sensor data ontbreekt' });
        }
        return null;
    }

    const decision = determineSetpoint(input);
    const statusKleur = decision.setpoint > 0 ? 'green' : decision.setpoint < 0 ? 'blue' : 'grey';
    const statusText = `Huis: ${decision.huisVerbruik}W | P1: ${Math.round(decision.p1Vermogen)}W | Accu: ${Math.round(decision.accuVermogen)}W | SOC: ${decision.soc}% | → ${decision.setpoint}W (${decision.reason})`;

    if (node && node.status) {
        node.status({
            fill: statusKleur,
            shape: 'dot',
            text: statusText
        });
    }

    // De uitvoer naar de rest van het systeem bestaat uit een payload met het gewenste
    // vermogensniveau en een statusbericht met de reden waarom deze keuze is gemaakt.
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
        payload: { value: decision.reason }
    };

    // Als de controller juist heeft besloten niets te doen, stuurt hij een vaste
    // null-status terug in plaats van een nutteloze power-waarde.
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
        controller
    };
}

if (typeof module === 'undefined' && typeof node !== 'undefined' && typeof msg !== 'undefined') {
    return controller(node, msg);
}