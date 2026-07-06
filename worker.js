// ============================================================
// KAKULE — Push Bildirim Köprüsü (Cloudflare Worker)
// ============================================================
// Bu fonksiyon, tarayıcının "Push API" standardını kullanarak
// gerçek push bildirimi gönderir. İstemci (gönderen kişinin cihazı),
// mesaj gönderdiğinde bu Worker'ı çağırır; Worker da alıcının
// tarayıcısına (Chrome/Firefox/Safari push servisine) şifrelenmiş
// bildirim gönderir. Hiçbir kredi kartı veya ücretli plan gerekmez.
// ============================================================

// CORS: sadece kendi GitHub Pages adresinizden gelen isteklere izin verin.
// KURULUM.md'deki adımı takip ederek bu değeri kendi adresinizle değiştirin.
const IZIN_VERILEN_KAYNAK = "*"; // Güvenlik için "https://kullaniciadi.github.io" yapın

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return corsYanit(new Response(null, { status: 204 }));
    }

    // ---- Test uç noktası: günlük özeti elle tetiklemek için ----
    // Tarayıcıdan şu adresi açarak test edebilirsiniz (cron'u günlerce
    // beklemeden): https://WORKER-ADRESINIZ/test-ozet?anahtar=GIZLI_ANAHTAR
    // GIZLI_ANAHTAR, Worker'a eklediğiniz TEST_ANAHTARI secret'ı ile aynı olmalı.
    const istekUrl = new URL(request.url);
    if (request.method === "GET" && istekUrl.pathname === "/test-ozet") {
      if (!env.TEST_ANAHTARI || !sabitZamanEsit(istekUrl.searchParams.get("anahtar") || "", env.TEST_ANAHTARI)) {
        return corsYanit(new Response("Yetkisiz", { status: 401 }));
      }
      // Varsayılan olarak GERÇEK push atar (tüm aileye). Tüm aileyi rahatsız
      // etmeden içeriği görmek için "&kuru=1" ekleyin: hiçbir bildirim
      // gönderilmez, sadece üretilecek özet metni döndürülür.
      const kuruMu = istekUrl.searchParams.get("kuru") === "1";
      try {
        if (kuruMu) {
          const onizleme = await gunlukOzetOnizle(env);
          return corsYanit(new Response(onizleme, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }));
        }
        await gunlukOzetGonder(env);
        return corsYanit(new Response("Günlük özet gönderildi.", { status: 200 }));
      } catch (err) {
        return corsYanit(new Response("Hata: " + err.message, { status: 500 }));
      }
    }

    if (request.method !== "POST") {
      return corsYanit(new Response("Sadece POST", { status: 405 }));
    }

    let veri;
    try {
      veri = await request.json();
    } catch {
      return corsYanit(new Response("Geçersiz JSON", { status: 400 }));
    }

    // Paylaşım anahtarı kontrolü: bu olmadan, Worker URL'sini bilen HERKES
    // dilediği subscription'a dilediği bildirimi gönderebilirdi.
    // Anahtar öncelikle "Authorization: Bearer <anahtar>" header'ından okunur
    // (loglara/proxy'lere sızma riskini azaltır); geriye dönük uyumluluk için
    // gövdedeki veri.anahtar da kabul edilir. Karşılaştırma sabit-zamanlıdır
    // (zamanlama saldırısına karşı).
    const authHeader = request.headers.get("Authorization") || "";
    const bearerAnahtar = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const gelenAnahtar = bearerAnahtar || veri.anahtar || "";
    if (!env.PAYLASIM_ANAHTARI || !sabitZamanEsit(gelenAnahtar, env.PAYLASIM_ANAHTARI)) {
      return corsYanit(new Response("Yetkisiz", { status: 401 }));
    }

    const { subscription, title, body, icon, url, tag, uid } = veri;
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return corsYanit(new Response("subscription eksik", { status: 400 }));
    }

    try {
      const payload = JSON.stringify({
        title: title || "Kakule",
        body: body || "Yeni mesaj",
        icon: icon || "icons/icon-192.png",
        url: url || "./",
        tag: tag || "kakule-mesaj"
      });

      await webPushGonder(subscription, payload, env);
      return corsYanit(new Response("OK", { status: 200 }));
    } catch (err) {
      // 404/410: abonelik kalıcı olarak geçersiz — Firestore'dan temizle
      // (uid bilgisi varsa; app.js her push isteğinde alıcının uid'sini yollar).
      if (uid && (err.status === 404 || err.status === 410) && env.FIREBASE_PROJECT_ID) {
        try {
          const token = await tekilIstekIcinTokenAl(env);
          await gecersizAbonelikTemizle(env, token, uid, subscription.endpoint);
        } catch { /* temizlik başarısız olursa sessizce geç, ana yanıtı etkilemesin */ }
      }
      return corsYanit(new Response("Hata: " + err.message, { status: 500 }));
    }
  },

  // ============================================================
  // GÜNLÜK ÖZET (cron) — wrangler.toml'daki crons ayarına göre
  // her gün otomatik tetiklenir (varsayılan: 06:00 UTC = 09:00 TR).
  // ============================================================
  async scheduled(event, env, ctx) {
    ctx.waitUntil(gunlukOzetGonder(env));
  }
};

// ============================================================
// GÜNLÜK ÖZET BİLDİRİMİ
// Her aile üyesine: kendi konumuna göre hava durumu + güncel
// dolar/euro/altın + 5 gündem başlığı + günün sözü içeren TEK bir
// push bildirimi gönderir.
// ============================================================

async function gunlukOzetGonder(env) {
  // Ortak (herkes için aynı) veriler — tek seferde çekilir.
  const [kurlar, haberler, soz] = await Promise.all([
    kurlariGetir(),
    haberleriGetir(env),
    Promise.resolve(gununSozu())
  ]);

  const token = await firestoreTokenAl(env);
  const kullanicilar = await kullanicilariGetir(env, token);

  // Kur satırı herkes için ortak — bir kez hesapla. Kur çekilemediyse
  // sessizce atlamak yerine açık bir "veri alınamadı" işareti gösteriyoruz.
  const kurSatiri = kurlar
    ? `💵 Dolar: ${kurlar.usd ?? "—"} ₺   💶 Euro: ${kurlar.eur ?? "—"} ₺   🪙 Gram Altın: ${kurlar.gram ?? "—"} ₺`
    : "💱 Kur bilgisi şu an alınamadı";

  // Aynı konumdaki üyeler için hava durumunu tekrar tekrar çekmemek adına
  // (lat,lng) -> hava sonucunu önbelleğe alıyoruz.
  const havaOnbellek = new Map();
  async function havaSatiriAl(konum) {
    if (konum?.lat == null || konum?.lng == null) return "";
    // ~2 ondalık (yaklaşık 1 km) hassasiyette anahtarla; komşuları tek çağrıda topla.
    const anahtar = `${konum.lat.toFixed(2)},${konum.lng.toFixed(2)}`;
    if (!havaOnbellek.has(anahtar)) {
      const hava = await havaDurumuGetir(konum.lat, konum.lng).catch(() => null);
      havaOnbellek.set(anahtar, hava
        ? `${hava.durum}  ${hava.sicaklik}°C (gün içi ${hava.min}°/${hava.maks}°)`
        : "");
    }
    return havaOnbellek.get(anahtar);
  }

  // Her kullanıcıyı paralel işle; içindeki push'ları da allSettled ile paralelle.
  await Promise.allSettled(kullanicilar.map(async (kullanici) => {
    const subs = kullanici.pushSubscriptions || [];
    if (!subs.length) return;
    if (kullanici.bildirimAyarlari?.gunlukOzetKapali === true) return;

    const havaSatiri = await havaSatiriAl(kullanici.sonKonum);

    const satirlar = [];
    if (havaSatiri) satirlar.push(`🌤️ Hava: ${havaSatiri}`);
    satirlar.push(kurSatiri);
    if (haberler.length) {
      satirlar.push("📰 Gündem:");
      haberler.forEach((h, i) => satirlar.push(`${i + 1}. ${h}`));
    }
    if (soz) satirlar.push(`💬 “${soz}”`);

    const govde = satirlar.join("\n");
    const baslik = `☀️ Günaydın ${kullanici.ad || ""}, günün özeti`;
    const payload = JSON.stringify({
      title: baslik,
      body: govde,
      icon: "icons/icon-192.png",
      url: "./",
      tag: "kakule-gunluk-ozet"
    });

    await Promise.allSettled(subs.map(async (sub) => {
      try {
        await webPushGonder(sub, payload, env);
      } catch (err) {
        console.warn(`Günlük özet gönderilemedi (${kullanici.uid}):`, err.message);
        if (err.status === 404 || err.status === 410) {
          await gecersizAbonelikTemizle(env, token, kullanici.uid, sub.endpoint).catch(() => {});
        }
      }
    }));
  }));
}

// Kuru çalıştırma: hiçbir push göndermeden, gönderilecek özetlerin metnini
// üretip döndürür (test-ozet?kuru=1 için). Tüm aileyi rahatsız etmez.
async function gunlukOzetOnizle(env) {
  const [kurlar, haberler, soz] = await Promise.all([
    kurlariGetir(),
    haberleriGetir(env),
    Promise.resolve(gununSozu())
  ]);
  const token = await firestoreTokenAl(env);
  const kullanicilar = await kullanicilariGetir(env, token);
  const kurSatiri = kurlar
    ? `💵 Dolar: ${kurlar.usd ?? "—"} ₺   💶 Euro: ${kurlar.eur ?? "—"} ₺   🪙 Gram Altın: ${kurlar.gram ?? "—"} ₺`
    : "💱 Kur bilgisi şu an alınamadı";

  const parcalar = [];
  for (const kullanici of kullanicilar) {
    const subs = kullanici.pushSubscriptions || [];
    const durum = kullanici.bildirimAyarlari?.gunlukOzetKapali === true
      ? " (günlük özet kapalı — atlanır)"
      : (!subs.length ? " (abonelik yok — atlanır)" : ` (${subs.length} cihaz)`);
    const satirlar = [];
    if (kullanici.sonKonum?.lat != null) {
      const hava = await havaDurumuGetir(kullanici.sonKonum.lat, kullanici.sonKonum.lng).catch(() => null);
      if (hava) satirlar.push(`🌤️ Hava: ${hava.durum}  ${hava.sicaklik}°C (gün içi ${hava.min}°/${hava.maks}°)`);
    }
    satirlar.push(kurSatiri);
    if (haberler.length) { satirlar.push("📰 Gündem:"); haberler.forEach((h, i) => satirlar.push(`${i + 1}. ${h}`)); }
    if (soz) satirlar.push(`💬 “${soz}”`);
    parcalar.push(`=== ${kullanici.ad || kullanici.uid}${durum} ===\n☀️ Günaydın ${kullanici.ad || ""}, günün özeti\n${satirlar.join("\n")}`);
  }
  return `KURU ÇALIŞTIRMA — hiçbir bildirim gönderilmedi.\n\n${parcalar.join("\n\n")}`;
}

// ---------- Firestore'dan (servis hesabı ile) kullanıcıları oku ----------

async function firestoreTokenAl(env) {
  const simdi = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: env.FIREBASE_CLIENT_EMAIL,
    scope: "https://www.googleapis.com/auth/datastore.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: simdi,
    exp: simdi + 3600
  };
  const headerB64 = b64urlEncode(strToBuf(JSON.stringify(header)));
  const claimB64 = b64urlEncode(strToBuf(JSON.stringify(claim)));
  const imzalanacak = `${headerB64}.${claimB64}`;

  const cryptoKey = await rsaOzelAnahtariIceAktar(env.FIREBASE_PRIVATE_KEY);
  const imza = new Uint8Array(
    await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, cryptoKey, strToBuf(imzalanacak))
  );
  const jwt = `${imzalanacak}.${b64urlEncode(imza)}`;

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });
  const veri = await res.json();
  if (!veri.access_token) throw new Error("Firebase erişim anahtarı alınamadı: " + JSON.stringify(veri));
  return veri.access_token;
}

async function rsaOzelAnahtariIceAktar(pemStr) {
  const pem = pemStr.replace(/\\n/g, "\n");
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const bin = atob(b64);
  const der = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i);
  return crypto.subtle.importKey(
    "pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]
  );
}

async function kullanicilariGetir(env, token) {
  const url = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/kullanicilar?pageSize=300`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const veri = await res.json();
  if (!res.ok) throw new Error("Kullanıcılar okunamadı: " + JSON.stringify(veri));
  return (veri.documents || []).map(firestoreBelgesiSadelestir);
}

// Firestore REST API'sinin tip-etiketli (stringValue/mapValue/...) formatını
// sade bir JS nesnesine çevirir.
function firestoreBelgesiSadelestir(belge) {
  function degerCevir(v) {
    if (v == null) return null;
    if ("stringValue" in v) return v.stringValue;
    if ("doubleValue" in v) return v.doubleValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("booleanValue" in v) return v.booleanValue;
    if ("nullValue" in v) return null;
    if ("timestampValue" in v) return v.timestampValue;
    if ("mapValue" in v) {
      const obj = {};
      for (const [k, val] of Object.entries(v.mapValue.fields || {})) obj[k] = degerCevir(val);
      return obj;
    }
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(degerCevir);
    return null;
  }
  const obj = {};
  for (const [k, v] of Object.entries(belge.fields || {})) obj[k] = degerCevir(v);
  obj.uid = belge.name.split("/").pop();
  return obj;
}

// Firestore belgesini sadeleştirmenin tersi: sade bir JS değerini, Firestore
// REST API'sinin beklediği tip-etiketli ({stringValue:...} vb.) formata çevirir.
function firestoreDegerKodla(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "string") return { stringValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === "boolean") return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(firestoreDegerKodla) } };
  if (typeof v === "object") {
    const fields = {};
    for (const [k, val] of Object.entries(v)) fields[k] = firestoreDegerKodla(val);
    return { mapValue: { fields } };
  }
  return { nullValue: null };
}

// ============================================================
// GEÇERSİZ/SÜRESİ DOLMUŞ PUSH ABONELİKLERİNİ TEMİZLEME
// ============================================================
// Bir push servisi (Chrome/Firefox/Safari) 404 veya 410 döndürdüğünde, bu
// "artık bu cihaz/tarayıcıya bildirim gönderilemez" (uygulama kaldırılmış,
// tarayıcı verisi temizlenmiş, vb.) anlamına gelir — geçici bir hata değil,
// KALICI bir durumdur. Böyle bir abonelik Firestore'da sonsuza dek kalırsa
// hem gereksiz yere şişer hem de her denemede boşuna hata üretir. Bu yüzden
// 404/410 alınca ilgili aboneliği kullanıcı belgesinden kalıcı olarak siliyoruz.
async function gecersizAbonelikTemizle(env, token, uid, sonEndpoint) {
  try {
    const belgeUrl = `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/kullanicilar/${uid}`;
    const getRes = await fetch(belgeUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!getRes.ok) return;
    const kullanici = firestoreBelgesiSadelestir(await getRes.json());
    const oncekiler = kullanici.pushSubscriptions || [];
    const kalanlar = oncekiler.filter((s) => s.endpoint !== sonEndpoint);
    if (kalanlar.length === oncekiler.length) return; // zaten yoktu, yapacak bir şey yok

    await fetch(`${belgeUrl}?updateMask.fieldPaths=pushSubscriptions`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { pushSubscriptions: firestoreDegerKodla(kalanlar) } })
    });
  } catch (err) {
    console.warn(`Geçersiz push aboneliği temizlenemedi (${uid}):`, err.message);
  }
}

// fetch() handler'ından (tekil mesaj bildirimi) gelen istekler için: Firestore
// erişim token'ı sadece gerçekten gerektiğinde (yani abonelik geçersiz çıkınca)
// alınır — her normal bildirimde ekstra bir OAuth isteği yapılmaz. Worker
// örneği kısa ömürlü olduğu için bu önbellek en fazla birkaç istek boyunca
// yaşar, sorun oluşturmaz.
let _tekilIstekTokenOnbellek = null;
async function tekilIstekIcinTokenAl(env) {
  if (!_tekilIstekTokenOnbellek) _tekilIstekTokenOnbellek = firestoreTokenAl(env);
  return _tekilIstekTokenOnbellek;
}



async function havaDurumuGetir(lat, lon) {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=Europe%2FIstanbul`;
    const res = await fetch(url);
    const veri = await res.json();
    return {
      sicaklik: Math.round(veri.current?.temperature_2m),
      maks: Math.round(veri.daily?.temperature_2m_max?.[0]),
      min: Math.round(veri.daily?.temperature_2m_min?.[0]),
      durum: havaKoduTanimla(veri.current?.weather_code)
    };
  } catch {
    return null;
  }
}

function havaKoduTanimla(kod) {
  const tablo = {
    0: "☀️ Açık", 1: "🌤️ Az bulutlu", 2: "⛅ Parçalı bulutlu", 3: "☁️ Kapalı",
    45: "🌫️ Sisli", 48: "🌫️ Kırağılı sis",
    51: "🌦️ Hafif çisenti", 53: "🌦️ Çisenti", 55: "🌧️ Yoğun çisenti",
    61: "🌧️ Hafif yağmur", 63: "🌧️ Yağmur", 65: "🌧️ Kuvvetli yağmur",
    71: "🌨️ Hafif kar", 73: "🌨️ Kar", 75: "❄️ Kuvvetli kar",
    80: "🌧️ Sağanak", 81: "🌧️ Kuvvetli sağanak", 82: "⛈️ Şiddetli sağanak",
    95: "⛈️ Gök gürültülü fırtına"
  };
  return tablo[kod] || "🌡️";
}

// ---------- Döviz / Altın kuru (Truncgil — anahtarsız, ücretsiz) ----------
// NOT: Bu, resmi olmayan ücretsiz bir servistir; alan adları zaman zaman
// değişebilir. Bu yüzden birkaç olası alan adı sırayla denenir.

async function kurlariGetir() {
  try {
    const res = await fetch("https://finans.truncgil.com/v3/today.json");
    const veri = await res.json();
    const bul = (...anahtarlar) => {
      for (const a of anahtarlar) {
        const kayit = veri[a];
        if (kayit && (kayit.Selling || kayit.Satış || kayit.satis)) {
          return kayit.Selling ?? kayit.Satış ?? kayit.satis;
        }
      }
      return null;
    };
    return {
      usd: bul("USD", "Dolar", "ABD DOLARI"),
      eur: bul("EUR", "Euro", "EURO"),
      gram: bul("gram-altin", "GRAM ALTIN", "Gram Altın", "Gram Altin")
    };
  } catch {
    return null;
  }
}

// ---------- Gündem haberleri (RSS — anahtarsız, ücretsiz) ----------
// KURULUM.md'de belirtildiği gibi RSS_KAYNAK_URL ortam değişkeniyle
// istenen herhangi bir Türkçe haber RSS adresiyle değiştirilebilir.

async function haberleriGetir(env) {
  const kaynak = (env && env.RSS_KAYNAK_URL) || "https://www.ntv.com.tr/gundem.rss";
  try {
    const res = await fetch(kaynak);
    const xml = await res.text();
    const baslikRegex = /<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g;
    const tumBasliklar = [...xml.matchAll(baslikRegex)].map((m) => m[1].trim());
    // RSS'in ilk <title> etiketi genelde kanalın kendi adıdır (örn. "NTV Gündem"),
    // o yüzden ilkini atlayıp sonraki 5 haberi alıyoruz.
    return tumBasliklar.slice(1, 6);
  } catch {
    return [];
  }
}

// ---------- Günün sözü ----------
// Tarihe göre dönen sabit bir liste (dış servise bağımlı olmadan çalışır).

const GUNUN_SOZLERI = [
  "Küçük adımlar, büyük yolculukların başlangıcıdır.",
  "Bugün yapabileceğini yarına bırakma.",
  "Gülümsemek, en kısa mesafedir.",
  "Sabır, acının anahtarıdır.",
  "Aile, kalbin en güvenli limanıdır.",
  "Her gün yeni bir başlangıçtır.",
  "Zorluklar, güçlü olduğumuzu hatırlatır.",
  "Sevgi paylaştıkça çoğalır.",
  "Bugün dün öğrendiklerinin meyvesidir.",
  "Küçük iyilikler büyük farklar yaratır.",
  "Umut, karanlıkta yanan bir mumdur.",
  "Birlik olan aile, her şeyi aşar.",
  "Gerçek başarı, sabırla gelir.",
  "Şükür, mutluluğun anahtarıdır.",
  "Her sabah yeni bir şans sunar.",
  "Hayat, anı yaşamayı öğretir.",
  "Dostluk, mesafeyle ölçülmez.",
  "Emek veren, sonunda kazanır.",
  "Bilgelik, dinlemekle başlar.",
  "Bugün attığın adım, yarının temelidir.",
  "Aile bağları, en güçlü bağlardır.",
  "Hayal kurmak, yarını inşa etmektir.",
  "Şefkat, en büyük güçtür.",
  "Vakit en değerli hediyedir.",
  "Tebessüm, en güzel dil bilmeyen dildir.",
  "Sevgiyle yapılan iş, eksik olmaz.",
  "Bugünün emeği, yarının huzurudur.",
  "İyi niyet, her kapıyı açar.",
  "Birlikte daha güçlüyüz.",
  "Her gün bir öğrenme fırsatıdır.",
  "Sevgi, en büyük mirastır."
];

function gununSozu() {
  const simdi = new Date();
  const yilBasi = new Date(simdi.getFullYear(), 0, 0);
  const farkMs = simdi - yilBasi;
  const gunSayisi = Math.floor(farkMs / (1000 * 60 * 60 * 24));
  return GUNUN_SOZLERI[gunSayisi % GUNUN_SOZLERI.length];
}

function corsYanit(res) {
  const yeni = new Response(res.body, res);
  yeni.headers.set("Access-Control-Allow-Origin", IZIN_VERILEN_KAYNAK);
  yeni.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  yeni.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return yeni;
}

// ============================================================
// Web Push protokolü (RFC 8291 şifreleme + RFC 8292 VAPID)
// ============================================================

async function webPushGonder(subscription, payloadStr, env) {
  const endpoint = subscription.endpoint;
  const p256dh = b64urlDecode(subscription.keys.p256dh);
  const auth = b64urlDecode(subscription.keys.auth);

  const { ciphertext, salt, serverPublicKey } = await sifrele(payloadStr, p256dh, auth);

  const audience = new URL(endpoint).origin;
  const jwt = await vapidJwtUret(audience, env.VAPID_PRIVATE_KEY, env.VAPID_PUBLIC_KEY, env.VAPID_SUBJECT || "mailto:aile@kakule.app");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "86400",
      "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`
    },
    body: ciphertext
  });

  if (!res.ok && res.status !== 201) {
    const metin = await res.text();
    const hata = new Error(`Push servisi hata verdi (${res.status}): ${metin}`);
    hata.status = res.status;
    throw hata;
  }
}

// ---------- RFC 8291: mesaj şifreleme (aes128gcm) ----------
async function sifrele(payloadStr, alicininP256dh, alicininAuth) {
  const tamMetin = new TextEncoder().encode(payloadStr);

  // Geçici (ephemeral) anahtar çifti üret
  const ephemeralKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]
  );
  const serverPublicKeyRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeralKeyPair.publicKey)
  );

  const alicininPublicKey = await crypto.subtle.importKey(
    "raw", alicininP256dh, { name: "ECDH", namedCurve: "P-256" }, [], []
  );

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: alicininPublicKey }, ephemeralKeyPair.privateKey, 256
    )
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // PRK = HMAC-SHA256(auth, sharedSecret)  (HKDF extract, "auth" salt)
  const authInfo = concatBuffers([
    strToBuf("WebPush: info\0"), alicininP256dh, serverPublicKeyRaw
  ]);
  const ikm = await hkdf(alicininAuth, sharedSecret, authInfo, 32);

  const cekInfo = strToBuf("Content-Encoding: aes128gcm\0");
  const cek = await hkdf(salt, ikm, cekInfo, 16);

  const nonceInfo = strToBuf("Content-Encoding: nonce\0");
  const nonce = await hkdf(salt, ikm, nonceInfo, 12);

  // aes128gcm içerik: [kayıt başlığı][padding-delimiter 0x02][payload]
  const padDelimiter = new Uint8Array([2]); // sondaki kayıt için 0x02, padding yok
  const duzMetin = concatBuffers([tamMetin, padDelimiter]);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const sifreliVeri = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, duzMetin)
  );

  // aes128gcm header: salt(16) || rs(4, big-endian, =4096) || idlen(1) || keyid(serverPublicKeyRaw)
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096 record size, big-endian uint32
  const idlen = new Uint8Array([serverPublicKeyRaw.length]);
  const header = concatBuffers([salt, rs, idlen, serverPublicKeyRaw]);

  const ciphertext = concatBuffers([header, sifreliVeri]);
  return { ciphertext, salt, serverPublicKey: serverPublicKeyRaw };
}

async function hkdf(salt, ikm, info, uzunluk) {
  const key = await crypto.subtle.importKey("raw", ikm, { name: "HKDF" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info }, key, uzunluk * 8
  );
  return new Uint8Array(bits);
}

// ---------- RFC 8292: VAPID JWT (ES256 imzalı) ----------
async function vapidJwtUret(audience, privateKeyB64url, publicKeyB64url, subject) {
  const header = { typ: "JWT", alg: "ES256" };
  const simdi = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: simdi + 12 * 60 * 60,
    sub: subject
  };

  const headerB64 = b64urlEncode(strToBuf(JSON.stringify(header)));
  const payloadB64 = b64urlEncode(strToBuf(JSON.stringify(payload)));
  const imzalanacak = `${headerB64}.${payloadB64}`;

  const cryptoKey = await ecPrivateKeyIceAktar(privateKeyB64url, publicKeyB64url);

  const imzaDer = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" }, cryptoKey, strToBuf(imzalanacak)
    )
  );

  // Web Crypto ECDSA imzası zaten "r || s" (raw, 64 byte) formatında döner — JWT için doğru format budur.
  const imzaB64 = b64urlEncode(imzaDer);
  return `${imzalanacak}.${imzaB64}`;
}

// Özel anahtarı (32 byte ham scalar) + public anahtarı (65 byte uncompressed point)
// kullanarak JWK formatında WebCrypto'ya aktarır. JWK formatı x/y/d üçünü de ister;
// x ve y, zaten elimizde olan public anahtardan (env.VAPID_PUBLIC_KEY) türetilir.
async function ecPrivateKeyIceAktar(privateKeyB64url, publicKeyB64url) {
  const privBytes = b64urlDecode(privateKeyB64url);
  const pubBytes = b64urlDecode(publicKeyB64url); // 0x04 || X(32) || Y(32)
  const x = pubBytes.slice(1, 33);
  const y = pubBytes.slice(33, 65);

  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: b64urlEncode(privBytes),
    x: b64urlEncode(x),
    y: b64urlEncode(y),
    ext: true,
    key_ops: ["sign"]
  };

  return crypto.subtle.importKey(
    "jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]
  );
}

// ---------- Yardımcılar ----------
// Sabit-zamanlı string karşılaştırma (zamanlama saldırısına karşı).
// Uzunluk farkında bile erken çıkmaz; tüm baytları XOR'layıp biriktirir.
function sabitZamanEsit(a, b) {
  const ab = strToBuf(String(a));
  const bb = strToBuf(String(b));
  let fark = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) {
    fark |= (ab[i] || 0) ^ (bb[i] || 0);
  }
  return fark === 0;
}

function strToBuf(s) { return new TextEncoder().encode(s); }
function concatBuffers(parcalar) {
  const toplam = parcalar.reduce((a, p) => a + p.length, 0);
  const sonuc = new Uint8Array(toplam);
  let ofset = 0;
  for (const p of parcalar) { sonuc.set(p, ofset); ofset += p.length; }
  return sonuc;
}
function b64urlEncode(buf) {
  let s = btoa(String.fromCharCode(...new Uint8Array(buf)));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
