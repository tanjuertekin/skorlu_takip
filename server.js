async function arkaPlanTaramasiYap(tf) {
    let state = botStates[tf];
    try {
        addLog(tf, "Arka plan testi başlatıldı (Sadece Yeşil Mumlar)...");
        
        let res = await fetch('https://api.binance.com/api/v3/ticker/24hr');
        if (!res.ok) res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
        let data = await res.json();
        
        if (!Array.isArray(data)) {
            addLog(tf, "Hata: Binance verisi alınamadı.");
            return;
        }

        let top50 = data.filter(i => i.symbol.endsWith('USDT') && !i.symbol.includes('USDC'))
            .sort((a,b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume)).slice(0, 50);

        let anlikFiyatlarMap = {};
        data.forEach(p => anlikFiyatlarMap[p.symbol] = parseFloat(p.lastPrice || p.price));

        let yeniSonuclar = [];

        for (let item of top50) {
            let symbol = item.symbol;
            let kRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${tf}&limit=10`);
            let klines = await kRes.json();
            if (!Array.isArray(klines) || klines.length < 5) continue;

            // Test: Sadece son kapanan muma bak (Yeşil mum mu? Yani Close > Open)
            let sonMum = klines[klines.length - 2];
            let acilisFiyati = parseFloat(sonMum[1]);
            let kapanisFiyati = parseFloat(sonMum[4]);

            if (kapanisFiyati > acilisFiyati) {
                let anlikFiyat = anlikFiyatlarMap[symbol] || kapanisFiyati;
                let stop = acilisFiyati * 0.99; // Test için basit stop
                
                yeniSonuclar.push({
                    parite: symbol + '.P',
                    yon: "LONG",
                    skor: 90, // Minimum skor testini geçmesi için yüksek skor
                    adx: "35.00",
                    stochRsi: { k: "75.0", d: "65.0" },
                    giris: parseFloat(anlikFiyat.toFixed(4)),
                    stop: parseFloat(stop.toFixed(4)),
                    tf
                });
            }
        }

        state.tarananSonuclar = yeniSonuclar;
        state.lastScanTime = new Date().toLocaleTimeString('tr-TR');
        addLog(tf, `Test Bitti. Bulunan Yeşil Mum Sayısı: ${yeniSonuclar.length}`);

        yeniSonuclar.forEach(item => {
            if (!state.acikIslemler.some(i => i.parite === item.parite && i.tf === item.tf)) {
                state.acikIslemler.push({
                    ...item,
                    anlikFiyat: item.giris,
                    pnlYuzde: 0,
                    zamanMs: Date.now(),
                    zaman: new Date().toLocaleTimeString('tr-TR')
                });
            }
        });

    } catch (e) {
        addLog(tf, "Test Hatası: " + e.message);
    }
}
