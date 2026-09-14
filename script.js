// ─── Configuratie ────────────────────────────────────────────────────────────
const CONFIG = {
    deviceId: "31c393bc5ba6bd424490fb39a18c9a72",
    maxCharge: -2500,       // W, negatief = laden
    maxDischarge: 1250,     // W, positief = ontladen

    PVLaden: true,         // true = laden op PV-overschot, false = terugleveren

    maxSOC: 100,
    minSOC: 12,
    deadband: 15,           // W, geen actie als verschil kleiner dan dit
    rampUp: 350,            // Setpoint verhogen/verlagen in stappen van rampUp Watt

    // Handmatig forceren
    forceChargeMaxCharge: 90,   // Stop geforceerd laden boven dit SoC %
    forceDischargeMinSoc: 25,   // Stop geforceerd ontladen onder dit SoC %

    // Prijssturing: laden
    prijsLaden: false,
    prijsLadenVerschil: 0.030,          // Max toeslag boven laagstePrijs om nog te laden
    prijsLadenVerschilVermogen: -1750,  // Laadvermogen bij prijsgestuurde lading
    prijsLadenMinVerschil: 0.11,        // Minimale dag-spread om op goedkoopste uur te laden
    prijsLadenMinSOC: 95,               // Hysterese: start laden onder dit SoC
    prijsLadenMaxCharge: 98,            // stop hysterese-laden boven dit SoC

    minSocPrijsOntladen: 70,

    // Prijssturing: ontladen
    minSpreadOntladen: 0.30,    // Minimale dag-spread om automatisch op hoogstePrijs te ontladen
    accuEfficiency: 0.80,       // Roundtrip-efficiency voor drempelberekening

    // Negatieve prijzen: laadvermogen per afstandsband (€/kWh verschil tov laagste)
    negPrijsBanden: [
        { maxVerschil: 0.05, vermogen: -2000 },
        { maxVerschil: 0.10, vermogen: -1500 },
        { maxVerschil: 0.25, vermogen: -1100 },
        { maxVerschil: 0.30, vermogen: -900 },
        { maxVerschil: Infinity, vermogen: -800 },
    ],

    socBuffer: 20   // Reserveer accucapaciteit voor de dure uren (ontladen wordt geblokkeerd onder dit SoC als prijs te laag is)
};
// ─────────────────────────────────────────────────────────────────────────────

const d = msg.data;

const p1 = Number((d.p1c * 1000) - (d.p1p * 1000)); // Netvermogen (+ = afname, - = teruglevering)
const accu = -Number(d.accu);                           // Accuvermogen (+ = ontladen, - = laden)
const pv = Number(d.pv);                              // PV-vermogen (W)

const soc = Number(d.soc);       // Accu SoC (%)
const nopdemeter = Number(d.target);    // Doelvermogen op de meter

const huidigePrijs = Number(d.prijs);          // Huidige dynamische prijs (€/kWh)
const laagstePrijs = Number(d.laagsteprijs);   // Laagste prijs vandaag
const hoogstePrijs = Number(d.hoogsteprijs);   // Hoogste prijs vandaag
const forceerLaden = d.force_charge === "on";
const forceerOntladen = d.force_discharge === "on";

// ─── Afgeleide prijsgrootheden ────────────────────────────────────────────────
const prijsVerschil = hoogstePrijs - laagstePrijs;

// FIX: efficiency wordt één keer toegepast op het netto prijsverschil
// Drempel = break-even prijs waarbij ontladen rendabel is na roundtrip-verlies
const prijsHoogteOntladen = laagstePrijs + (prijsVerschil * CONFIG.accuEfficiency);
const prijsHoogteOntladen2 = laagstePrijs + (prijsVerschil * 0.2);

const ladenOnderPrijs = laagstePrijs + CONFIG.prijsLadenVerschil;

// ─── Validatie ────────────────────────────────────────────────────────────────
if (isNaN(parseFloat(d.p1)) || isNaN(parseFloat(d.accu))) {
    node.status({ fill: "red", shape: "ring", text: "Sensor data ontbreekt" });
    return null;
}

// ─── Basisberekeningen ────────────────────────────────────────────────────────
let huisverbruik = Math.round(Math.abs(p1 + accu + pv));
let doelSetpoint = Math.round(p1 + accu - nopdemeter);
let reden = "";
let stop = false;

// Initieel setpoint op basis van meterbalans
if (doelSetpoint < 0) {
    if (CONFIG.PVLaden || prijsVerschil < CONFIG.prijsLadenMinVerschil && doelSetpoint <= -75) {
        reden = `Laden op PV-overschot (${Math.abs(doelSetpoint)} W)`;
    } else {
        doelSetpoint = 0;
        reden = "PV-overschot, voorkeur terugleveren";
    }
} else if (doelSetpoint > 0) {
    reden = `Ontladen ${doelSetpoint} W`;
}

// ─── Handmatig forceren ───────────────────────────────────────────────────────
if (forceerLaden && soc < CONFIG.forceChargeMaxCharge) {
    doelSetpoint = CONFIG.maxCharge;
    reden = "Handmatig laden";
} else if (forceerOntladen && soc > CONFIG.forceDischargeMinSoc) {
    doelSetpoint = CONFIG.maxDischarge;
    reden = "Handmatig ontladen";

    // ─── Prijssturing ─────────────────────────────────────────────────────────────
} else {

    // --- Negatieve prijzen ---
    if (huidigePrijs < 0) {
        if (huidigePrijs !== laagstePrijs) {
            // Goedkoper dan 0 maar niet de absolute laagste: schaal vermogen naar afstand
            const verschilNegPrijs = Math.abs(huidigePrijs - laagstePrijs);
            const band = CONFIG.negPrijsBanden.find(b => verschilNegPrijs < b.maxVerschil);
            doelSetpoint = band.vermogen;
            reden = `Prijs negatief (€${huidigePrijs.toFixed(4)}/kWh), laden op ${Math.abs(doelSetpoint)} W`;
        } else {
            doelSetpoint = CONFIG.maxCharge;
            reden = `Laagste prijs van de dag negatief (€${huidigePrijs.toFixed(4)}/kWh), max laden`;
        }

        // --- Hoogste prijs: ontladen als spread groot genoeg en SoC voldoende ---
    } else if (
        huidigePrijs === hoogstePrijs &&
        prijsVerschil >= CONFIG.minSpreadOntladen &&  // FIX: geen ontladen bij kleine spread
        soc > CONFIG.minSocPrijsOntladen
    ) {
        doelSetpoint = CONFIG.maxDischarge;
        reden = `Hoogste prijs (€${huidigePrijs.toFixed(4)}/kWh), spread €${prijsVerschil.toFixed(3)}, SoC ${soc}% — ontladen`;

        // --- Goedkoopste uur: vol laden ---
    } else if (huidigePrijs === laagstePrijs && prijsVerschil >= CONFIG.prijsLadenMinVerschil) {
        if (huisverbruik >= 2500) {
            doelSetpoint = -500;
        } else {
            doelSetpoint = CONFIG.maxCharge;
        }
        reden = `Goedkoopste uur (€${huidigePrijs.toFixed(4)}/kWh), spread €${prijsVerschil.toFixed(3)}`;

        // --- Prijs laag genoeg om bij te laden (hysterese) ---
    } else if (huidigePrijs <= ladenOnderPrijs && prijsVerschil >= CONFIG.prijsLadenMinVerschil && CONFIG.prijsLaden) {
        let prijsLadenActief = context.get('prijsLadenActief') || false;

        // Hysterese: start onder minSOC, stop boven maxCharge (FIX: maxCharge bestond niet)
        if (!prijsLadenActief && soc < CONFIG.prijsLadenMinSOC) {
            prijsLadenActief = true;
            context.set('prijsLadenActief', true);
        } else if (prijsLadenActief && soc >= CONFIG.prijsLadenMaxCharge) {
            prijsLadenActief = false;
            context.set('prijsLadenActief', false);
        }

        if (prijsLadenActief) {
            let tmpVermogenReken = ((1 - huidigePrijs) / 2) * CONFIG.prijsLadenVerschilVermogen;
            let pvMinVerbruik = (pv - p1);
            let vermogenMinPV = Math.max(tmpVermogenReken, -pvMinVerbruik);

            let min300watt = Math.min(-300, vermogenMinPV);

            doelSetpoint = Math.min(-300, (Math.max((((1 - huidigePrijs) / 2) * CONFIG.prijsLadenVerschilVermogen), -pv)));
            // doelSetpoint = min300watt;
            reden = `Prijsgestuurde bijlading (€${huidigePrijs.toFixed(4)}/kWh), SoC ${soc}%`;
        }
    }

    // --- Deadband: geen actie als verschil te klein ---
    const deadbandVerschil = Math.round(Math.abs(accu - doelSetpoint));
    if (deadbandVerschil < CONFIG.deadband && soc > CONFIG.minSOC && soc < CONFIG.maxSOC) {
        stop = true;
    }

    // --- Ontlaadsterkte te laag: negeren ---
    if (doelSetpoint > 0 && doelSetpoint < 50 && pv < 200) {
        reden = "Ontlaadsterkte te laag, negeren";
        doelSetpoint = 0;
    }

    if (huidigePrijs < prijsHoogteOntladen2 && doelSetpoint > 0) {
        reden = `Prijs te laag om te ontladen.`
        doelSetpoint = 0;
    }

    // --- Prijs te laag om te ontladen (buffer beschermen) ---
    if (soc < CONFIG.socBuffer && huidigePrijs < prijsHoogteOntladen && doelSetpoint > 0) {
        reden = `Prijs €${huidigePrijs.toFixed(4)} < drempel €${prijsHoogteOntladen.toFixed(4)}, buffer (${CONFIG.socBuffer}%) beschermen`;
        doelSetpoint = 0;
    }

    // --- Vandaag negatieve prijzen: niet laden op overschot als prijs positief ---
    if (laagstePrijs < 0 && doelSetpoint < 0 && huidigePrijs > 0) {
        reden = `Dag heeft negatieve prijs (laagste €${laagstePrijs.toFixed(4)}), laden bewaren voor dat moment`;
        doelSetpoint = 0;
    }
}

// ─── SoC-grenzen ─────────────────────────────────────────────────────────────
if (soc >= CONFIG.maxSOC && doelSetpoint < 0) {
    reden = `Accu vol (${soc}%)`;
    doelSetpoint = 0;
}
if (soc <= CONFIG.minSOC && doelSetpoint > 0) {
    reden = `Accu leeg (${soc}%)`;
    doelSetpoint = 0;
}

// Efficientie
if (doelSetpoint < 0 && doelSetpoint > -100) {
    reden = `Te kleine lading, voorkeur terugleveren vanwege accu efficientie`
    doelSetpoint = 0;
}

// ─── Clamp naar limieten ─────────────────────────────────────────────────────
doelSetpoint = Math.max(CONFIG.maxCharge, Math.min(CONFIG.maxDischarge, doelSetpoint));

// ─── Ramp-up: stap vanuit huidig accuvermogen richting doel ──────────────────
let setpoint;
if (!stop) {
    if (doelSetpoint > accu) {
        setpoint = Math.min(doelSetpoint, accu + CONFIG.rampUp);
    } else if (doelSetpoint < accu) {
        setpoint = Math.max(doelSetpoint, accu - CONFIG.rampUp);
    } else {
        setpoint = doelSetpoint;
    }

    if (setpoint < 0) reden = reden || `Accu laden (${setpoint} W)`;
    else if (setpoint > 0) reden = reden || `Accu ontladen (${setpoint} W)`;
    else reden = reden || "Balans";

    if (setpoint !== doelSetpoint) {
        reden += ` [ramp: ${Math.round(accu)}→${Math.round(setpoint)} (doel: ${doelSetpoint})]`;
    }
} else {
    setpoint = accu; // Geen stuur nodig, houd huidige stand
}

// Stop ook als accu al stilstaat en setpoint nul is
if (setpoint === 0 && accu <= 10 && accu >= -10) {
    stop = true;
}

// ─── Status ──────────────────────────────────────────────────────────────────
const kleur = setpoint > 0 ? "green" : setpoint < 0 ? "blue" : "grey";
node.status({
    fill: kleur,
    shape: "dot",
    text: `Huis: ${huisverbruik} W | P1: ${Math.round(p1)} W | Accu: ${Math.round(accu)} W | SoC: ${soc}% | → ${setpoint} W (${reden}) | laagste: €${laagstePrijs} | huidig: €${huidigePrijs} | PV: ${pv} W | Ontlaadprijs: ${prijsHoogteOntladen}`
});

// ─── Uitvoer ──────────────────────────────────────────────────────────────────
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
    payload: { value: reden }
};

if (stop) {
    return [null, msgStatus];
} else {
    return [msgPayload, msgStatus];
}