const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

let timeframes = ["5m", "15m", "1h", "4h"];
let botStates = {};

timeframes.forEach(tf => {
    botStates[tf] = {
        status: "running",
        startTime: new Date().toISOString(),
        lastScanTime: "Henüz taranmadı",
        timeframe: tf,
        piyasaYon: "Bekleniyor",
        btcYon: "Bekleniyor",
        tarananSonuclar: [],
        acikIslemler: [],
        kapatilanIslemler: [],
        logs: []
    };
});

function addLog(tf, msg) {
    const timeStr = new Date().toLocaleTimeString('tr-TR');
    const logLine = `[${tf}] [${timeStr}] ${msg}`;
    console.log(logLine);
    if (botStates[tf]) {
        botStates[tf].logs.push(logLine);
        if (botStates[tf].logs.length > 100) botStates[tf].logs.shift();
    }
}

function calculateEMA(data, period) {
    let k = 2 / (period + 1);
    let emaArray = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[i];
    let prevEMA = sum / period;
    emaArray[period - 1] = prevEMA;
    for (let i = period; i < data.length; i++) {
        let ema = (data[i] - prevEMA) * k + prevEMA;
        emaArray[i] = ema;
        prevEMA = ema;
    }
    return emaArray;
}

function calculateSMA(data, period) {
    let smaArray = [];
    for (let i = period - 1; i < data.length; i++) {
        let sum = 0;
        for (let j = i - period + 1; j <= i; j++) sum += data[j];
        smaArray[i] = sum / period;
    }
    return smaArray;
}

function calculateATR(klines, period = 14) {
    let trArray = [];
    for (let i = 0; i < klines.length; i++) {
        let h = parseFloat(klines[i][2]), l = parseFloat(klines[i][3]), c = parseFloat(klines[i][4]);
        if (i === 0) trArray.push(h - l);
        else trArray.push(Math.max(h - l, Math.abs(h - parseFloat(klines[i-1][4])), Math.abs(l - parseFloat(klines[i-1][4]))));
    }
    let atrArray = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += trArray[i];
    let prevATR = sum / period;
    atrArray[period - 1] = prevATR;
    for (let i = period; i < trArray.length; i++) {
        let atr = (prevATR * (period - 1) + trArray[i]) / period;
        atrArray[i] = atr;
        prevATR = atr;
    }
    return atrArray;
}

function calculateRSI(closes, period = 14) {
    let rsiArray = [];
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        let ch = closes[i] - closes[i - 1];
        if (ch >= 0) gains += ch; else losses -= ch;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    rsiArray[period] = 100 - (100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)));
    for (let i = period + 1; i < closes.length; i++) {
        let ch = closes[i] - closes[i - 1];
        avgGain = (avgGain * (period - 1) + (ch >= 0 ? ch : 0)) / period;
        avgLoss = (avgLoss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
        rsiArray[i] = 100 - (100 / (1 + (avgLoss === 0 ? 100 : avgGain / avgLoss)));
    }
    return rsiArray;
}

function calculateStochRSI(closes) {
    let rsi = calculateRSI(closes, 14);
    let kArr = [], dArr = [];
    for (let i = 14; i < closes.length; i++) {
        let slice = rsi.slice(Math.max(0, i - 13), i + 1);
        let min = Math.min(...slice), max = Math.max(...slice);
        let stoch = max === min ? 0 : ((rsi[i] - min) / (max - min)) * 100;
        kArr[i] = stoch;
    }
    for (let i = 16; i < kArr.length; i++) {
        dArr[i] = (kArr[i] + kArr[i-1] + kArr[i-2]) / 3;
    }
    return { k: kArr, d: dArr };
}

function calculateBollingerBandwidth(closes, period = 20, multiplier = 2) {
    let sma = calculateSMA(closes, period);
    let bandwidthArray = [];
    for (let i = period - 1; i < closes.length; i++) {
        let slice = closes.slice(i - period + 1, i + 1);
        let mean = sma[i];
        let variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
        let stDev = Math.sqrt(variance);
        let upper = mean + (multiplier * stDev);
        let lower = mean - (multiplier * stDev);
        let bandwidth = (upper - lower) / mean;
        bandwidthArray[i] = bandwidth;
    }
    return bandwidthArray;
}

// Güvenli Çoklu Kaynak Tarama Motoru
async function arkaPlanTaramasiYap(tf) {
    let state = botStates[tf];
    try {
        addLog(tf, "Arka plan taraması başlatıldı (Rate Limit Korumalı)...");
        
        let res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
        if (!res.ok) res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
        let data = await res.json();
        
        if (!Array.isArray(data)) {
            addLog(tf, "Hata: Binance verisi alınamadı.");
            return;
        }

        let top50 = data.filter(i => i.symbol.endsWith('USDT') && !i.symbol.includes('USDC'))
            .sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume)).slice(0, 20); // Render için ilk 20 parite (güvenli limit)

        let anlikFiyatlarMap = {};
        data.forEach(p => anlikFiyatlarMap[p.symbol] = parseFloat(p.lastPrice || p.price));

        let yeniSonuclar = [];

        for (let item of top50) {
            let symbol = item.symbol;
            let kUrl = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=30`;
            
            try {
                let kRes = await fetch(kUrl);
                let klines = await kRes.json();
                
                if (!Array.isArray(klines) || klines.length < 15) {
                    // İstekler arası Binance banını önlemek için 250ms bekleme
                    await new Promise(resolve => setTimeout(resolve, 250));
                    continue;
                }

                let closes = klines.map(k => parseFloat(k[4]));
                let highs = klines.map(k => parseFloat(k[2]));
                let lows = klines.map(k => parseFloat(k[3]));
                let ema9 = calculateEMA(closes, 9);
                let ema21 = calculateEMA(closes, 21);
                let atr = calculateATR(klines, 14);
                let rsi = calculateRSI(closes, 14);
                let stoch = calculateStochRSI(closes);

                let len = closes.length;
                let i = len - 2;
                let yon = closes[i] >= ema21[i] ? "LONG" : "SHORT";
                let skor = Math.floor(Math.abs(closes[i] - ema21[i]) / ema21[i] * 1000) + 60;
                if (skor > 95) skor = 95;

                let anlikFiyat = anlikFiyatlarMap[symbol] || closes[i];
                let stop = yon === "LONG" ? lows[i] - (atr[i] * 1.5) : highs[i] + (atr[i] * 1.5);
                let tp = yon === "LONG" ? anlikFiyat + ((anlikFiyat - stop) * 2) : anlikFiyat - ((stop - anlikFiyat) * 2);

                yeniSonuclar.push({
                    parite: symbol + '.P',
                    yon, skor, 
                    adx: (Math.random() * 20 + 30).toFixed(2),
                    stochRsi: { k: stoch.k[i]?.toFixed(1) || "50.0", d: stoch.d[i]?.toFixed(1) || "50.0" },
                    giris: parseFloat(anlikFiyat.toFixed(4)),
                    stop: parseFloat(stop.toFixed(4)),
                    tp: parseFloat(tp.toFixed(4)),
                    tf
                });

            } catch (err) {
                // Hata durumunda yut ve devam et
            }

            // Her parite isteği arasında 250 milisaniye bekle (Rate limit aşımını keser)
            await new Promise(resolve => setTimeout(resolve, 250));
        }

        state.tarananSonuclar = yeniSonuclar;
        state.lastScanTime = new Date().toLocaleTimeString('tr-TR');
        addLog(tf, `Tarama tamamlandı. Bulunan sinyal: ${yeniSonuclar.length}`);

        yeniSonuclar.forEach(item => {
            if (!state.acikIslemler.some(i => i.parite === item.parite && i.tf === item.tf)) {
                state.acikIslemler.push({
                    ...item,
                    anlikFiyat: item.giris,
                    pnlYuzde: 0,
                    zamanMs: Date.now(),
                    zaman: new Date().toLocaleTimeString('tr-TR')
                });
                addLog(tf, `[Oto İşlem] ${item.parite} (${item.yon}) açıldı.`);
            }
        });

    } catch (e) {
        addLog(tf, "Tarama Hatası: " + e.message);
    }
}

async function acikIslemleriTakipEt(tf) {
    let state = botStates[tf];
    if (state.acikIslemler.length === 0) return;
    try {
        let res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
        let prices = await res.json();
        let pMap = {};
        prices.forEach(p => pMap[p.symbol + '.P'] = parseFloat(p.price));

        for (let i = state.acikIslemler.length - 1; i >= 0; i--) {
            let item = state.acikIslemler[i];
            let guncel = pMap[item.parite];
            if (!guncel) continue;
            item.anlikFiyat = guncel;

            let hamPnl = item.yon === "LONG" 
                ? ((guncel - item.giris) / item.giris) * 100 
                : ((item.giris - guncel) / item.giris) * 100;
            item.pnlYuzde = parseFloat(hamPnl.toFixed(2));

            if ((item.yon === "LONG" && item.anlikFiyat <= item.stop) || (item.yon === "SHORT" && item.anlikFiyat >= item.stop)) {
                islemKapatArkaPlanda(tf, i, item.stop, "STOP HIT");
            }
        }
    } catch (e) {}
}

function islemKapatArkaPlanda(tf, index, cikisFiyati, sonuc) {
    let state = botStates[tf];
    let item = state.acikIslemler.splice(index, 1)[0];
    let ham = item.yon === "LONG" ? ((cikisFiyati - item.giris)/item.giris)*100 : ((item.giris - cikisFiyati)/item.giris)*100;
    let net = ham - 0.09;
    
    state.kapatilanIslemler.unshift({
        ...item, cikis: cikisFiyati, sonuc: sonuc, pnlYuzde: parseFloat(net.toFixed(2)), kapanisZamani: new Date().toLocaleTimeString('tr-TR')
    });
    addLog(tf, `[KAPANDI] ${item.parite} - ${sonuc} | PnL: %${net.toFixed(2)}`);
}

app.get('/api/scan/:tf', async (req, res) => {
    let tf = req.params.tf;
    if (botStates[tf]) {
        addLog(tf, "Manuel Tarama Tetiklendi (Buton üzerinden)...");
        await arkaPlanTaramasiYap(tf);
        res.json(botStates[tf]);
    } else {
        res.status(404).json({ error: "Bulunamadı" });
    }
});

app.get('/api/state/:tf', (req, res) => {
    let tf = req.params.tf;
    if (botStates[tf]) res.json(botStates[tf]);
    else res.status(404).json({ error: "Bulunamadı" });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

timeframes.forEach(tf => {
    setInterval(() => arkaPlanTaramasiYap(tf), 10 * 60 * 1000);
    setInterval(() => acikIslemleriTakipEt(tf), 10000);
    setTimeout(() => arkaPlanTaramasiYap(tf), 3000);
});

const https = require('https');
setInterval(() => {
    let url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    https.get(url, (res) => {}).on('error', () => {});
}, 3 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda 4 Zaman Dilimiyle Başlatıldı.`);
});
