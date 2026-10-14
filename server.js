const express = require('express');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname)));

let timeframes = ["5m", "15m", "30m", "1h", "4h", "1d"];
let botStates = {};

timeframes.forEach(tf => {
    botStates[tf] = {
        status: "running",
        startTime: new Date().toISOString(),
        lastScanTime: "Henüz taranmadı",
        timeframe: tf,
        piyasaYon: "Bekleniyor",
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

function hesaplaRSIArray(closes, period = 14) {
    let rsiArray = [];
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
        let diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    rsiArray.push(avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss))));

    for (let i = period + 1; i < closes.length; i++) {
        let diff = closes[i] - closes[i - 1];
        if (diff >= 0) {
            avgGain = (avgGain * (period - 1) + diff) / period;
            avgLoss = (avgLoss * (period - 1)) / period;
        } else {
            avgGain = (avgGain * (period - 1)) / period;
            avgLoss = (avgLoss * (period - 1) - diff) / period;
        }
        let rsi = avgLoss === 0 ? 100 : 100 - (100 / (1 + (avgGain / avgLoss)));
        rsiArray.push(rsi);
    }
    return rsiArray;
}

function hesaplaStochRSI(closes, period = 14, kPeriod = 3, dPeriod = 3) {
    if (closes.length < period + kPeriod + dPeriod) return { k: 50, d: 50 };
    let rsiValues = hesaplaRSIArray(closes, period);
    if (rsiValues.length < kPeriod) return { k: 50, d: 50 };

    let stochRsiValues = [];
    for (let i = period - 1; i < rsiValues.length; i++) {
        let slice = rsiValues.slice(Math.max(0, i - period + 1), i + 1);
        let highRsi = Math.max(...slice);
        let lowRsi = Math.min(...slice);
        let currentRsi = rsiValues[i];
        let stoch = (highRsi - lowRsi) === 0 ? 50 : ((currentRsi - lowRsi) / (highRsi - lowRsi)) * 100;
        stochRsiValues.push(stoch);
    }

    let kValues = [];
    for (let i = kPeriod - 1; i < stochRsiValues.length; i++) {
        let slice = stochRsiValues.slice(i - kPeriod + 1, i + 1);
        let sum = slice.reduce((a, b) => a + b, 0);
        kValues.push(sum / kPeriod);
    }

    let dValues = [];
    for (let i = dPeriod - 1; i < kValues.length; i++) {
        let slice = kValues.slice(i - dPeriod + 1, i + 1);
        let sum = slice.reduce((a, b) => a + b, 0);
        dValues.push(sum / dPeriod);
    }

    let k = kValues.length > 0 ? kValues[kValues.length - 1] : 50;
    let d = dValues.length > 0 ? dValues[dValues.length - 1] : 50;

    return { k: parseFloat(k.toFixed(2)), d: parseFloat(d.toFixed(2)) };
}

function hesaplaADX(klines, period = 14) {
    if (klines.length < period * 2) return 25;
    let highs = klines.map(k => parseFloat(k[2]));
    let lows = klines.map(k => parseFloat(k[3]));
    let closes = klines.map(k => parseFloat(k[4]));

    let trs = [], plusDMs = [], minusDMs = [];
    for (let i = 1; i < klines.length; i++) {
        let high = highs[i], low = lows[i], prevHigh = highs[i - 1], prevLow = lows[i - 1], prevClose = closes[i - 1];
        let tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trs.push(tr);

        let upMove = high - prevHigh;
        let downMove = prevLow - low;

        let plusDM = (upMove > downMove && upMove > 0) ? upMove : 0;
        let minusDM = (downMove > upMove && downMove > 0) ? downMove : 0;
        plusDMs.push(plusDM);
        minusDMs.push(minusDM);
    }

    let smoothTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
    let smoothPlusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
    let smoothMinusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);

    let dxValues = [];
    for (let i = period; i < trs.length; i++) {
        smoothTR = smoothTR - (smoothTR / period) + trs[i];
        smoothPlusDM = smoothPlusDM - (smoothPlusDM / period) + plusDMs[i];
        smoothMinusDM = smoothMinusDM - (smoothMinusDM / period) + minusDMs[i];

        let plusDI = smoothTR === 0 ? 0 : (smoothPlusDM / smoothTR) * 100;
        let minusDI = smoothTR === 0 ? 0 : (smoothMinusDM / smoothTR) * 100;

        let sumDI = plusDI + minusDI;
        let dx = sumDI === 0 ? 0 : (Math.abs(plusDI - minusDI) / sumDI) * 100;
        dxValues.push(dx);
    }

    if (dxValues.length < period) return 25;

    let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < dxValues.length; i++) {
        adx = ((adx * (period - 1)) + dxValues[i]) / period;
    }

    return parseFloat(adx.toFixed(2));
}

function hesaplaEMA(data, period) {
    let k = 2 / (period + 1);
    let emaArray = [data[0]];
    for (let i = 1; i < data.length; i++) {
        emaArray.push((data[i] * k) + (emaArray[i - 1] * (1 - k)));
    }
    return emaArray;
}

function safAlgoritmaAnalizi(klines) {
    let closes = klines.map(k => parseFloat(k[4]));
    let highs = klines.map(k => parseFloat(k[2]));
    let lows = klines.map(k => parseFloat(k[3]));
    let currentPrice = closes[closes.length - 1];

    let adxVal = hesaplaADX(klines);
    if (adxVal < 20) return null;

    let stochRsi = hesaplaStochRSI(closes);
    let yon = "";
    if (stochRsi.k > stochRsi.d) {
        yon = "LONG";
    } else if (stochRsi.k < stochRsi.d) {
        yon = "SHORT";
    } else {
        return null;
    }
    
    let ema20 = hesaplaEMA(closes, 20);
    let sonEma20 = ema20[ema20.length - 1];
    
    let recentHighs = highs.slice(-15);
    let recentLows = lows.slice(-15);
    let yakinDirenc = Math.max(...recentHighs);
    let yakinDestek = Math.min(...recentLows);

    let adxPuan = Math.min(Math.max((adxVal - 20) / 40, 0), 1) * 40;
    let stochFark = Math.abs(stochRsi.k - stochRsi.d);
    let stochPuan = Math.min(stochFark / 30, 1) * 30;

    let trendPuan = 30;
    if (yon === "LONG" && currentPrice < sonEma20) trendPuan = 10;
    if (yon === "SHORT" && currentPrice > sonEma20) trendPuan = 10;

    let hesaplananSkor = Math.round(adxPuan + stochPuan + trendPuan);
    if (hesaplananSkor < 15) hesaplananSkor = 15;
    if (hesaplananSkor > 100) hesaplananSkor = 100;

    let giris = currentPrice;
    let stop;

    if (yon === "LONG") {
        let adaylar = [sonEma20, yakinDestek].filter(val => val < giris);
        stop = adaylar.length > 0 ? Math.max(...adaylar) : giris * 0.98;
    } else {
        let adaylar = [sonEma20, yakinDirenc].filter(val => val > giris);
        stop = adaylar.length > 0 ? Math.min(...adaylar) : giris * 1.02;
    }

    return {
        yon, skor: hesaplananSkor, adx: adxVal, stochRsi,
        giris: parseFloat(giris.toFixed(4)),
        stop: parseFloat(stop.toFixed(4))
    };
}

async function arkaPlanTaramasiYap(tf) {
    let state = botStates[tf];
    try {
        addLog(tf, "Arka plan strateji taraması başlatıldı (Spot API Güvenceli)...");
        
        let res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
        let data = await res.json();
        if (!Array.isArray(data)) {
            addLog(tf, "Hata: Spot 24hr verisi alınamadı.");
            return;
        }

        let aktifPariteler = data.filter(item => item.symbol.endsWith('USDT') && !item.symbol.includes('USDC'))
                                   .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
                                   .slice(0, 30).map(item => item.symbol + '.P');

        let hamSinyaller = [];

        for (let parite of aktifPariteler) {
            let temizParite = parite.replace('.P', '');
            try {
                let kRes = await fetch(`https://api.binance.com/api/v3/klines?symbol=${temizParite}&interval=${tf}&limit=100`);
                let klines = await kRes.json();
                if (!Array.isArray(klines) || klines.length < 50) continue;

                let sonuc = safAlgoritmaAnalizi(klines);
                if (!sonuc) continue;

                hamSinyaller.push({ parite, ...sonuc });
            } catch (e) {}
            await new Promise(resolve => setTimeout(resolve, 150));
        }

        hamSinyaller.sort((a, b) => b.skor - a.skor);
        state.tarananSonuclar = hamSinyaller;
        state.lastScanTime = new Date().toLocaleTimeString('tr-TR');
        addLog(tf, `Tarama tamamlandı. Bulunan sinyal: ${hamSinyaller.length}`);

    } catch (e) {
        addLog(tf, "Tarama Hatası: " + e.message);
    }
}

async function acikIslemleriTakipEt(tf) {
    let state = botStates[tf];
    if (state.acikIslemler.length === 0) return;
    try {
        let res = await fetch('https://api.binance.com/api/v3/ticker/price');
        let fiyatlar = await res.json();
        let fiyatMap = {};
        fiyatlar.forEach(f => { fiyatMap[f.symbol + '.P'] = parseFloat(f.price); });

        let kapatilacaklar = [];

        state.acikIslemler.forEach(islem => {
            let guncel = fiyatMap[islem.parite];
            if (!guncel) return;
            islem.anlikFiyat = guncel;

            let pnlYuzde = islem.yon === "LONG" 
                ? ((guncel - islem.giris) / islem.giris) * 100 
                : ((islem.giris - guncel) / islem.giris) * 100;
            islem.pnlYuzde = parseFloat(pnlYuzde.toFixed(2));

            if (islem.yon === "LONG") {
                if (!islem.enYuksekFiyat || guncel > islem.enYuksekFiyat) {
                    islem.enYuksekFiyat = guncel;
                    let yeniStop = islem.enYuksekFiyat * (1 - (islem.tslYuzde / 100));
                    if (yeniStop > islem.stop) islem.stop = parseFloat(yeniStop.toFixed(4));
                }
                if (guncel <= islem.stop) kapatilacaklar.push({ islem, sonuc: 'TSL', fiyat: islem.stop });
            } else {
                if (!islem.enYuksekFiyat || guncel < islem.enYuksekFiyat) {
                    islem.enYuksekFiyat = guncel;
                    let yeniStop = islem.enYuksekFiyat * (1 + (islem.tslYuzde / 100));
                    if (yeniStop < islem.stop) islem.stop = parseFloat(yeniStop.toFixed(4));
                }
                if (guncel >= islem.stop) kapatilacaklar.push({ islem, sonuc: 'TSL', fiyat: islem.stop });
            }
        });

        kapatilacaklar.forEach(k => islemKapatArkaPlanda(tf, k.islem, k.sonuc, k.fiyat));
    } catch (e) {}
}

function sureFormatla(ms) {
    let saniye = Math.floor(ms / 1000);
    let saat = Math.floor(saniye / 3600);
    saniye %= 3600;
    let dakika = Math.floor(saniye / 60);
    saniye %= 60;
    let sonuc = "";
    if (saat > 0) sonuc += saat + "s ";
    if (dakika > 0 || saat > 0) sonuc += dakika + "d ";
    sonuc += saniye + "sn";
    return sonuc;
}

function islemKapatArkaPlanda(tf, islem, sonucTipi, cikisFiyati) {
    let state = botStates[tf];
    let index = state.acikIslemler.findIndex(i => i.id === islem.id);
    if (index === -1) return;
    state.acikIslemler.splice(index, 1);

    let hamPnl = islem.yon === "LONG" 
        ? ((cikisFiyati - islem.giris) / islem.giris) * 100 
        : ((islem.giris - cikisFiyati) / islem.giris) * 100;
    
    let netPnlYuzde = hamPnl - 0.10;
    let gecenSureMs = Date.now() - (islem.acilisZamaniMs || Date.now());

    state.kapatilanIslemler.unshift({
        parite: islem.parite,
        yon: islem.yon,
        giris: islem.giris,
        cikis: cikisFiyati,
        sonuc: sonucTipi,
        pnlYuzde: parseFloat(netPnlYuzde.toFixed(2)),
        gecenSure: sureFormatla(gecenSureMs),
        acilisZamani: islem.zaman || 'Bilinmiyor',
        kapanisZamani: new Date().toLocaleTimeString('tr-TR')
    });
    addLog(tf, `[Kapandı] ${islem.parite} -> ${sonucTipi} | Net PnL: %${netPnlYuzde.toFixed(2)}`);
}

app.get('/api/state/:tf', (req, res) => {
    let tf = req.params.tf;
    if (botStates[tf]) res.json(botStates[tf]);
    else res.status(404).json({ error: "Bulunamadı" });
});

app.get('/api/scan/:tf', async (req, res) => {
    let tf = req.params.tf;
    if (botStates[tf]) {
        addLog(tf, "Manuel Tarama Tetiklendi...");
        await arkaPlanTaramasiYap(tf);
        res.json(botStates[tf]);
    } else {
        res.status(404).json({ error: "Bulunamadı" });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

timeframes.forEach(tf => {
    setInterval(() => arkaPlanTaramasiYap(tf), 15 * 60 * 1000);
    setInterval(() => acikIslemleriTakipEt(tf), 10000);
});

const https = require('https');
setInterval(() => {
    let url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    https.get(url, (res) => {}).on('error', () => {});
}, 3 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`Sunucu ${PORT} portunda Spot API Güvenceli Başlatıldı.`);
});
