// ─── Configuratie ────────────────────────────────────────────────────────────
const CONFIG = {
    deviceId: "31c393bc5ba6bd424490fb39a18c9a72",

    // Vermogensgrenzen (Watt)
    maxLaadVermogen: -2500,          // W (negatief = laden uit het net/PV)
    maxOntlaadVermogen: 1250,        // W (positief = ontladen naar huis/net)
    minLaadVermogenDrempel: -100,    // W, negeer te kleine laadacties i.v.m. rendement
    minOntlaadVermogenDrempel: 50,   // W, negeer te kleine ontlaadacties

    // Accucapaciteit en limieten (%)
    minSoc: 12,                      // % minimale accucapaciteit (ondergrens)
    maxSoc: 100,                     // % maximale accucapaciteit (bovengrens)
    socBuffer: 20,                   // % reserve voor dure uren (beschermt acculading)

    // Besturing & Snelheid
    deadband: 15,                    // W, negeer kleine vermogensschommelingen
    rampUpStap: 350,                 // W per cyclus voor geleidelijke vermogensopbouw

    // Zonne-energie
    ladenOpPvOverschot: true,       // true = PV-overschot opslaan in accu

    // Handmatig forceren
    forceerLadenMaxSoc: 90,          // Stop geforceerd laden boven dit SOC %
    forceerOntladenMinSoc: 25,       // Stop geforceerd ontladen onder dit SOC %

    // Dynamische Prijssturing (Arbitrage)
    prijsSturingActief: true,        // Activeer slim laden/ontladen op dynamische uurprijzen
    minPrijsSpreadOntladen: 0.12,    // €/kWh minimale dagspread voor piek-ontladen naar net
    minPrijsSpreadLaden: 0.08,       // €/kWh minimale dagspread om netladen te activeren
    prijsLadenVerschil: 0.04,        // €/kWh boven laagste prijs om nog bij te laden
    minSocPrijsOntladen: 60,         // % minimale SOC vereist om te ontladen naar net op piekuur

    // Rendement & Slijtage
    accuEfficiency: 0.85,            // RTE(Roundtrip efficiency) (bijv. 85%)
    degradatieKosten: 0.02,          // €/kWh slijtagekosten per kWh

    // Negatieve prijsbanden (€/kWh verschil t.o.v. de absolute laagste dagprijs)
    negatievePrijsBanden: [
        { maxVerschil: 0.05, vermogen: -2500 },
        { maxVerschil: 0.10, vermogen: -2000 },
        { maxVerschil: 0.25, vermogen: -1500 },
        { maxVerschil: Infinity, vermogen: -1000 }
    ]
};
// ─────────────────────────────────────────────────────────────────────────────

const inputData = msg.data;

// ─── Validatie Sensor Data ───────────────────────────────────────────────────
if (isNaN(parseFloat(inputData.p1c)) && isNaN(parseFloat(inputData.p1))) {
    node.status({ fill: "red", shape: "ring", text: "Sensor data ontbreekt" });
    return null;
}

// ─── Datatransformatie & Sensorwaarden ───────────────────────────────────────
const p1Vermogen = Number((inputData.p1c * 1000) - (inputData.p1p * 1000)); // + = afname, - = teruglevering
const accuVermogen = -Number(inputData.accu);                               // + = ontladen, - = laden
const pvVermogen = Number(inputData.pv);                                     // PV opbrengst in Watt
const soc = Number(inputData.soc);                                           // Accu SOC in %
const meterDoel = Number(inputData.target);                                  // Gewenst vermogen op de P1-meter (meestal 0)

// Dynamische tarieven (€/kWh)
const huidigePrijs = Number(inputData.prijs);
const laagstePrijs = Number(inputData.laagsteprijs);
const hoogstePrijs = Number(inputData.hoogsteprijs);

// Handmatige schakelaars
const forceerLaden = inputData.force_charge === "on";
const forceerOntladen = inputData.force_discharge === "on";

// ─── Financiële Berekeningen ─────────────────────────────────────────────────
const prijsVerschil = hoogstePrijs - laagstePrijs;

// Minimale verkoopprijs waarbij ontladen van ingekochte stroom rendabel is
const breakEvenOntlaadPrijs = (laagstePrijs / CONFIG.accuEfficiency) + CONFIG.degradatieKosten;

// ─── Basis Berekeningen ──────────────────────────────────────────────────────
const huisVerbruik = Math.round(Math.abs(p1Vermogen + accuVermogen + pvVermogen));
let doelSetpoint = Math.round(p1Vermogen + accuVermogen - meterDoel);
let reden = "";
let stop = false;

// ─── 1. Standaard Balanssturing (PV Overschot & Eigen Verbruik) ───────────────
if (doelSetpoint < 0) {
    if (CONFIG.ladenOpPvOverschot) {
        reden = `Laden op PV-overschot (${Math.abs(doelSetpoint)} W)`;
    } else {
        doelSetpoint = 0;
        reden = "PV-overschot, voorkeur voor teruglevering";
    }
} else if (doelSetpoint > 0) {
    reden = `Eigen verbruik dekken (${doelSetpoint} W)`;
}

// ─── 2. Handmatige Overrules ─────────────────────────────────────────────────
if (forceerLaden && soc < CONFIG.forceerLadenMaxSoc) {
    doelSetpoint = CONFIG.maxLaadVermogen;
    reden = "Handmatig laden geforceerd";
} else if (forceerOntladen && soc > CONFIG.forceerOntladenMinSoc) {
    doelSetpoint = CONFIG.maxOntlaadVermogen;
    reden = "Handmatig ontladen geforceerd";

// ─── 3. Dynamische Prijssturing (Arbitrage) ─────────────────────────
} else if (CONFIG.prijsSturingActief) {

    // A. Negatieve prijzen: Maak optimaal gebruik van geld toe krijgen op stroom opname
    if (huidigePrijs < 0) {
        if (huidigePrijs === laagstePrijs) {
            doelSetpoint = CONFIG.maxLaadVermogen;
            reden = `Laagste prijs is negatief (€${huidigePrijs.toFixed(4)}), maximaal laden`;
        } else {
            const verschilMetLaagste = Math.abs(huidigePrijs - laagstePrijs);
            const band = CONFIG.negatievePrijsBanden.find(b => verschilMetLaagste <= b.maxVerschil);
            doelSetpoint = band ? band.vermogen : CONFIG.maxLaadVermogen;
            reden = `Negatieve prijs (€${huidigePrijs.toFixed(4)}), laden op ${Math.abs(doelSetpoint)} W`;
        }

    // B. Hoogste uur van de dag: Maximaal ontladen naar het net als de spread groot genoeg is
    } else if (
        huidigePrijs === hoogstePrijs &&
        prijsVerschil >= CONFIG.minPrijsSpreadOntladen &&
        soc > CONFIG.minSocPrijsOntladen
    ) {
        doelSetpoint = CONFIG.maxOntlaadVermogen;
        reden = `Piek-uur (€${huidigePrijs.toFixed(4)}), spread €${prijsVerschil.toFixed(3)} — max ontladen naar net`;

    // C. Goedkoopste uur van de dag: Snel volladen tegen het laagste tarief
    } else if (
        huidigePrijs === laagstePrijs &&
        prijsVerschil >= CONFIG.minPrijsSpreadLaden &&
        soc < CONFIG.maxSoc
    ) {
        doelSetpoint = CONFIG.maxLaadVermogen;
        reden = `Goedkoopste uur van de dag (€${huidigePrijs.toFixed(4)}), maximaal laden`;

    // D. Voordelige uren: Bijladen uit het net wanneer prijs dicht bij het dagdieptepunt ligt
    } else if (
        huidigePrijs <= (laagstePrijs + CONFIG.prijsLadenVerschil) &&
        prijsVerschil >= CONFIG.minPrijsSpreadLaden &&
        soc < CONFIG.maxSoc
    ) {
        doelSetpoint = CONFIG.maxLaadVermogen;
        reden = `Voordelig tarief (€${huidigePrijs.toFixed(4)}), bijladen uit het net`;
    }
}

// ─── 4. Rendementscontroles & Accubescherming ────────────────────────────────

// Ontladen blokkeren als de acculading onder de buffer komt en de prijs niet boven break-even ligt
if (doelSetpoint > 0 && soc <= CONFIG.socBuffer) {
    if (huidigePrijs < breakEvenOntlaadPrijs) {
        doelSetpoint = 0;
        reden = `Bufferbescherming (${CONFIG.socBuffer}% SOC): prijs €${huidigePrijs.toFixed(3)} onder break-even €${breakEvenOntlaadPrijs.toFixed(3)}`;
    }
}

// Kleine vermogens negeren i.v.m. omvormer-efficiëntieverliezen
if (doelSetpoint < 0 && doelSetpoint > CONFIG.minLaadVermogenDrempel) {
    doelSetpoint = 0;
    reden = "Laadvermogen te laag voor efficiënt rendement";
}
if (doelSetpoint > 0 && doelSetpoint < CONFIG.minOntlaadVermogenDrempel && pvVermogen < 200) {
    doelSetpoint = 0;
    reden = "Ontlaadvermogen te laag voor efficiënt rendement";
}

// Harde SOC grenzen bewaken
if (soc >= CONFIG.maxSoc && doelSetpoint < 0) {
    doelSetpoint = 0;
    reden = `Accu is vol (${soc}%)`;
}
if (soc <= CONFIG.minSoc && doelSetpoint > 0) {
    doelSetpoint = 0;
    reden = `Accu is leeg (${soc}%)`;
}

// ─── 5. Deadband Controle ───────────────────────────────────────────────────
const vermogensVerschil = Math.abs(accuVermogen - doelSetpoint);
if (vermogensVerschil < CONFIG.deadband && soc > CONFIG.minSoc && soc < CONFIG.maxSoc) {
    stop = true;
}

// ─── 6. Vermogenslimieten Clampen ───────────────────────────────────────────
doelSetpoint = Math.max(CONFIG.maxLaadVermogen, Math.min(CONFIG.maxOntlaadVermogen, doelSetpoint));

// ─── 7. Ramp-Up (Geleidelijke Vermogensopbouw) ──────────────────────────────
let setpoint;
if (!stop) {
    if (doelSetpoint > accuVermogen) {
        setpoint = Math.min(doelSetpoint, accuVermogen + CONFIG.rampUpStap);
    } else if (doelSetpoint < accuVermogen) {
        setpoint = Math.max(doelSetpoint, accuVermogen - CONFIG.rampUpStap);
    } else {
        setpoint = doelSetpoint;
    }

    if (setpoint < 0) reden = reden || `Accu laden (${setpoint} W)`;
    else if (setpoint > 0) reden = reden || `Accu ontladen (${setpoint} W)`;
    else reden = reden || "Balans bereikt";

    if (setpoint !== doelSetpoint) {
        reden += ` [ramp: ${Math.round(accuVermogen)}→${Math.round(setpoint)} W (doel: ${doelSetpoint} W)]`;
    }
} else {
    setpoint = accuVermogen;
}

// Geen actie nodig als de accu stilstaat en het doel nul is
if (setpoint === 0 && Math.abs(accuVermogen) <= 10) {
    stop = true;
}

// ─── 8. Node Status & Output ────────────────────────────────────────────────
const statusKleur = setpoint > 0 ? "green" : setpoint < 0 ? "blue" : "grey";
node.status({
    fill: statusKleur,
    shape: "dot",
    text: `Huis: ${huisVerbruik}W | P1: ${Math.round(p1Vermogen)}W | Accu: ${Math.round(accuVermogen)}W | SOC: ${soc}% | → ${setpoint}W (${reden})`
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
    payload: { value: reden }
};

if (stop) {
    return [null, msgStatus];
} else {
    return [msgPayload, msgStatus];
}