# Acculogica

[![CI](https://github.com/laurenshoogendijk/acculogica/actions/workflows/test.yml/badge.svg)](https://github.com/laurenshoogendijk/acculogica/actions/workflows/test.yml)

Deze controller stuurt een thuisbatterij op basis van een combinatie van:

- eigen verbruik en PV-overschot
- handmatige overrides
- dynamische energietarieven
- SOC-beperkingen
- rendement- en slijtageafwegingen

De logica is ontworpen voor gebruik in Home Assistant als een Node-RED of JavaScript-basisfunctie die een batterij kan laden of ontladen op een bepaald vermogen.

## Wat doet de logica?

De controller berekent een doelvermogen voor de batterij en bepaalt vervolgens een veilige, geleidelijke setpoint. De belangrijkste doelen zijn:

1. Gebruik PV-overschot zoveel mogelijk om de batterij op te laden.
2. Vermijd onnodig laden of ontladen wanneer het rendement te laag is.
3. Gebruik dynamische stroomprijzen om te profiteren van goedkope uren of piekprijzen.
4. Bescherm de batterij tegen extreem lage of hoge SOC-waarden.
5. Houd de setpoint binnen veilige vermogenslimieten.

## Ingangswaarden

De functie verwacht een `msg.data` object met de volgende waarden:

- `p1c`: verbruik in kW of een maatwaarde die omgezet wordt naar vermogensafname
- `p1p`: teruglevering in kW
- `p1`: alternatieve meterwaarde
- `accu`: huidige batterijstroom in W
- `pv`: PV-opbrengst in W
- `soc`: actuele state of charge in %
- `target`: gewenst meterdoelvermogen
- `prijs`: actuele elektriciteitsprijs in €/kWh
- `laagsteprijs`: laagste prijs van de dag
- `hoogsteprijs`: hoogste prijs van de dag
- `force_charge`: handmatig laden aan/uit
- `force_discharge`: handmatig ontladen aan/uit

Belangrijk: `accu` wordt intern verwerkt als een stroom die positief is voor ontladen en negatief voor laden.

## Sturing in praktische termen

### 1. Basisbalans

De controller berekent eerst de balans tussen:

- netmeter
- batterijstroom
- PV-opbrengst
- gewenst doelvermogen

Als er een PV-overschot is, wordt geprobeerd om dat overschot op te slaan in de batterij. Als de woning meer stroom verbruikt dan beschikbaar is, wordt geprobeerd om de batterij te ontladen om het eigen verbruik te dekken.

### 2. Handmatige overrules

Er kunnen handmatige overrides worden ingevoerd:

- `force_charge`: dwingt laden totdat een maximale SOC wordt bereikt
- `force_discharge`: dwingt ontladen totdat een minimale SOC wordt bereikt

Deze overrides hebben voorrang boven de standaardregelingen.

### 3. Dynamische prijssturing

Als dynamische prijssturing actief is, wordt de batterij gestuurd op basis van de geldprijs:

- bij negatieve prijzen: extra laden om betaald te krijgen voor stroomgebruik
- bij hoge piekprijzen: ontladen naar het net als de spread groot genoeg is
- bij lage prijzen: bijladen uit het net als het interessant is

De controller houdt rekening met:

- minimale spread voor slimme arbitrage
- minimale SOC voor netto ontladen
- break-even-prijs voor ontladen vanuit de accu
- rendementsafwegingen

### 4. SOC-beveiliging

Er zijn harde grenzen:

- minimale SOC: 12%
- maximale SOC: 100%

Wanneer de accu vol is, stopt laden. Wanneer de accu bijna leeg is, stopt ontladen.

### 5. Rendement en slijtage

De logica negeert kleine vermogensschommelingen en voorkomt onrendabele acties:

- kleine laad- of ontlaadvermogens worden genegeerd
- ontladen wordt geblokkeerd als de netprijs lager is dan de break-evenprijs van de accu
- de batterij wordt niet continu heen en weer gestuurd door een deadband

### 6. Ramp-up

Om de omvormer en batterij te sparen, wordt de setpoint niet direct in één stap aangepast. In plaats daarvan wordt een geleidelijke opbouw gebruikt met een `rampUpStap`.

## Home Assistant setup

De controller is bedoeld om te worden gebruikt als een JavaScript- of Node-RED-logica in Home Assistant. De exacte opzet hangt af van je installatie, maar hieronder staat het gebruikelijke patroon.

### Vereiste onderdelen

Je hebt typisch het volgende nodig:

- Home Assistant
- een integratie die de volgende sensoren beschikbaar maakt:
  - P1-meterverbruik / teruglevering
  - PV-opbrengst
  - accu stroom
  - accu SOC
  - actuele energieprijs
  - laagste en hoogste prijs van de dag
- een actuator of custom integration die een setpoint naar de batterij kan sturen, bijvoorbeeld [Marstek Local API](https://community.home-assistant.io/t/marstek-local-api-v1-0-0-stable-release/942264)

### Typische sensoren

Voorbeeld van basiswaarden die je in Home Assistant dient te hebben:

- `sensor.p1_verbruik`
- `sensor.p1_teruglevering`
- `sensor.pv_opbrengst`
- `sensor.battery_power`
- `sensor.battery_soc`
- `sensor.electricity_price`
- `sensor.lowest_price_today`
- `sensor.highest_price_today`

Je kunt dit mappen naar de velden in `msg.data`.

### Mapping tabel voor Home Assistant

| Scriptveld | Home Assistant-waarde | Uitleg |
| --- | --- | --- |
| `p1c` | `sensor.p1_verbruik` | Verbruik op de P1-meter in kW of een vergelijkbare waarde |
| `p1p` | `sensor.p1_teruglevering` | Teruglevering op de P1-meter |
| `accu` | `sensor.battery_power` | Actuele batterijstroom in W, positief voor ontladen |
| `pv` | `sensor.pv_opbrengst` | PV-opbrengst in W |
| `soc` | `sensor.battery_soc` | Accu SOC in % |
| `target` | `input_number.battery_target` of `0` | Gewenst P1-doelvermogen |
| `prijs` | `sensor.electricity_price` | Huidige stroomprijs in €/kWh |
| `laagsteprijs` | `sensor.lowest_price_today` | Laagste dagprijs |
| `hoogsteprijs` | `sensor.highest_price_today` | Hoogste dagprijs |
| `force_charge` | `input_boolean.force_charge` | Handmatig laden aan/uit |
| `force_discharge` | `input_boolean.force_discharge` | Handmatig ontladen aan/uit |

> Let op: in veel installaties wordt `battery_power` als positieve waarde voor laden gemeten. In dat geval moet je de signaalrichting aanpassen zodat de controller de juiste interpretatie krijgt.

### Uitgang

De controller levert een object met een power-setpoint terug, bijvoorbeeld:

```javascript
{
  payload2: {
    data: {
      device_id: "...",
      time_num: 0,
      start_time: "00:00",
      end_time: "23:59",
      days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
      power: -2500
    }
  }
}
```

- negatieve waarde = laden
- positieve waarde = ontladen

Deze waarde kan vervolgens worden doorgegeven aan een batterijcontroller, slimme energiemodule, of een Home Assistant-entity die een vermogenssetpoint accepteert.

### Node-RED voorbeeld

Als je Node-RED gebruikt:

1. voeg een `function` node toe
2. zet `msg.data` op de juiste velden
3. plak de inhoud van `script.js` in de node
4. stuur de output naar de batterijactuator

Voorbeeld van een Node-RED `function` node:

```javascript
const msgData = {
  p1c: msg.payload.p1c || 2.082,
  p1p: msg.payload.p1p || 0,
  accu: msg.payload.accu || 2588,
  pv: msg.payload.pv || 637,
  soc: msg.payload.soc || 54,
  target: msg.payload.target || 0,
  prijs: msg.payload.prijs || 0.17468,
  laagsteprijs: msg.payload.laagsteprijs || 0.15343,
  hoogsteprijs: msg.payload.hoogsteprijs || 0.43321,
  force_charge: msg.payload.force_charge || 'off',
  force_discharge: msg.payload.force_discharge || 'off'
};

msg.data = msgData;
return msg;
```

De output van de controller wordt als volgt gebruikt:

```javascript
if (msg.payload2 && msg.payload2.data && msg.payload2.data.power !== undefined) {
  msg.payload = msg.payload2.data.power;
  return msg;
}
```

Dit kan daarna een Home Assistant-entity of batterijcontroller aansturen.

### Gebruik van de meegeleverde Node-RED flow

Het bestand [node-red-flow.json](node-red-flow.json) is een voorbeeldflow voor Home Assistant + Node-RED. In deze versie zijn de installatie-specifieke IDs en serverreferenties vervangen door placeholder-waarden zodat je deze veilig kunt delen of bewaren.

Gebruik:

1. Open Home Assistant > Node-RED.
2. Ga naar Menu > Import > Clipboard of Import > JSON File.
3. Kies [node-red-flow.json](node-red-flow.json).
4. Controleer de knoppen en entiteiten in de flow.
5. Vervang de placeholder-entiteiten door jouw eigen Home Assistant-entities.
6. Bewaar de flow en zet de automatische regeling aan.

Belangrijk:

- de flow is een voorbeeld en geen volledig “drop-in” voor een andere installatie
- je moet waarschijnlijk je eigen entities en serverconnectie aanpassen
- controleer de entities die in de `api-current-state`-nodes worden gelezen
- controleer de service-call nodes voor de batterij- of Marstek-acties

### Home Assistant Python/JS oplossing

Als je de logica in een custom script of automation wilt draaien:

1. verzamel alle metingen als JSON
2. bouw `msg.data` op in hetzelfde formaat
3. roep de controller aan
4. gebruik de teruggegeven `power` als setpoint

## Belangrijkste aandachtspunten

- Controleer altijd of de batterijstroom correct is geïnterpreteerd.
- Let op het verschil tussen `p1c` en `p1p` en hoe die worden omgerekend.
- Gebruik een duidelijke SOC-bereik om te voorkomen dat de accu over- of ondermatig gebruikt wordt.
- Test de regelaar in een veilige omgeving voordat je hem op een live installatie laat draaien.
- Controleer periodiek of de prijzen goed worden doorgegeven, vooral bij dynamic tariffs.

## Voorbeeld run

Er is ook een demo in dit project aanwezig:

```bash
npm start
```

Deze demo gebruikt voorbeeldwaarden en toont de setpoint die de logica zou kiezen.

## Samenvatting

Deze regelaar is bedoeld om een thuisbatterij slim te beheren op basis van:

- eigen verbruik
- PV-opbrengst
- energieprijzen
- SOC-status
- rendement en bescherming

Het resultaat is een geautomatiseerde, veilige en economische batterijsturing die zonder handmatige invoer werkt in een Home Assistant-omgeving.
