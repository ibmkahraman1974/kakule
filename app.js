// ============================================================
// KAKULE — Uygulama Mantığı
// ============================================================
import { firebaseConfig, KURULUS_ANAHTARI, CLOUDINARY_CLOUD, CLOUDINARY_PRESET, VAPID_PUBLIC_KEY, CF_WORKER_URL, TURN_URL, TURN_KULLANICI, TURN_SIFRE } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  onAuthStateChanged, signOut, sendPasswordResetEmail,
  EmailAuthProvider, reauthenticateWithCredential,
  updatePassword, updateEmail, deleteUser
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, setDoc, getDoc, updateDoc, deleteDoc,
  collection, addDoc, query, where, orderBy, onSnapshot,
  serverTimestamp, getDocs, limit, arrayUnion, arrayRemove, increment, deleteField, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Çevrimdışı kalıcı önbellek (IndexedDB): uygulama internet olmadan da açılır,
// daha hızlı yüklenir ve çevrimdışıyken gönderilen mesajlar bağlantı gelince
// otomatik iletilir. persistentMultipleTabManager: aynı anda birden çok sekme
// açık olsa da önbellek tutarlı kalır. Persistence desteklenmeyen (çok eski)
// tarayıcılarda sessizce normal (bellekte) moda düşer.
let db;
try {
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
  });
} catch (e) {
  console.warn("Çevrimdışı önbellek açılamadı, bellek modu kullanılıyor:", e?.message);
  db = initializeFirestore(app, {});
}

// ---------- Cloudinary yükleme (dosya/görsel — ücretsiz) ----------
async function cloudinaryYukle(dosya) {
  const fd = new FormData();
  fd.append("file", dosya);
  fd.append("upload_preset", CLOUDINARY_PRESET);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/auto/upload`, {
    method: "POST",
    body: fd
  });
  if (!res.ok) throw new Error("Cloudinary yükleme hatası: " + res.statusText);
  const json = await res.json();
  return json.secure_url;
}

// ---------- Görsel sıkıştırma (canvas) ----------
const GORSEL_MAKS_KENAR = 1280;   // px — uzun kenar bu değere indirilir
const GORSEL_JPEG_KALITE = 0.82;  // 0-1 arası; 0.82 ≈ %82 kalite

function gorseliSikistir(dosya) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(dosya);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      let g = img.width, y = img.height;
      if (g <= GORSEL_MAKS_KENAR && y <= GORSEL_MAKS_KENAR) {
        // Zaten küçük — sadece JPEG'e çevir
      } else {
        const oran = Math.min(GORSEL_MAKS_KENAR / g, GORSEL_MAKS_KENAR / y);
        g = Math.round(g * oran);
        y = Math.round(y * oran);
      }
      const canvas = document.createElement("canvas");
      canvas.width = g; canvas.height = y;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, g, y);
      canvas.toBlob(
        (blob) => {
          if (!blob) { reject(new Error("Canvas sıkıştırma başarısız")); return; }
          const sikistirilmis = new File([blob], dosya.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
          resolve(sikistirilmis);
        },
        "image/jpeg",
        GORSEL_JPEG_KALITE
      );
    };
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("Görsel yüklenemedi")); };
    img.src = objectUrl;
  });
}

// ---------- Genel durum ----------
let suankiKullanici = null;     // { uid, ad, eposta }

// ---------- Worker paylaşım anahtarı (GitHub'a değil, Firestore'a saklanır) ----------
// Bu anahtar firebase-config.js'de DEĞİL çünkü o dosya herkese açık (GitHub).
// Onun yerine, sadece giriş yapmış (davetiyeli) üyelerin okuyabildiği
// /ayarlar/workerAnahtar belgesinden okunuyor — bkz. firestore.rules ve
// KURULUM.md "2c" bölümü. Uygulama açıldığında bir kez okunup önbelleğe alınır.
let workerPaylasimAnahtari = null;
async function workerAnahtariniYukle() {
  try {
    const snap = await getDoc(doc(db, "ayarlar", "workerAnahtar"));
    workerPaylasimAnahtari = snap.exists() ? (snap.data().anahtar || null) : null;
  } catch (err) {
    console.warn("Worker paylaşım anahtarı okunamadı, push bildirimleri çalışmayabilir:", err.message);
  }
}
let tumUyeler = {};              // uid -> { ad, eposta, cevrimici }
let aktifSohbetId = null;
let aktifSohbetTipi = null;      // 'birebir' | 'grup'
let aktifSohbetKarsi = null;     // birebir ise karşı tarafın uid'i
let mesajAbonelik = null;
let sohbetlerAbonelik = null;

// WebRTC durumu
let pc = null;                   // RTCPeerConnection
let yerelStream = null;
let aktifAramaId = null;
let aramaRolu = null;            // 'arayan' | 'arayan-degil'

// ---------- BULUŞMA modülü durumu ----------
let aktifBulusmaId = null;          // içinde bulunulan buluşma belgesi
let bulusmaHarita = null;           // Leaflet map örneği
let bulusmaMarkerlar = {};          // uid -> Leaflet marker
let bulusmaHatti = null;            // iki kişi arası altın çizgi (polyline)
let bulusmaKonumWatchId = null;     // navigator.geolocation.watchPosition id
let bulusmaKatilimciAbonelik = null;// katılımcı konumları onSnapshot
let bulusmaBelgeAbonelik = null;    // buluşma belgesi onSnapshot
let bulusmaSonYazim = 0;            // konum throttle için son yazma zamanı (ms)
let bulusmaSonYazilanKonum = null;  // { lat, lng } — anlamsız tekrarları önlemek için
let bulusmaSaglandiGosterildi = false;
let leafletYukleniyor = null;
const BULUSMA_YAKINLIK_METRE = 50;  // "Buluşma Sağlandı" eşiği
const BULUSMA_YAZIM_ARALIK_MS = 4000; // konum en fazla ~4sn'de bir yazılır
const BULUSMA_MIN_HAREKET_M = 8;    // bu kadar hareket yoksa yazma (pil/maliyet)
let aramaTipi = null;            // 'sesli' | 'goruntulu'
let aramaAbonelikler = [];

// Verilen TURN_URL'den hem orijinal girişi hem de (üretilebiliyorsa) TLS/443
// üzerinden çalışan bir "turns:" girişini döndürür. Böylece düz TURN'ün
// bloklandığı kısıtlı ağlarda arama yine bağlanabilir.
function turnGirisleriUret(url, kullanici, sifre) {
  const kimlik = { username: kullanici, credential: sifre };
  const girisler = [{ urls: url, ...kimlik }];
  try {
    // "turn:host:80?transport=..." -> "turns:host:443?transport=tcp"
    const m = url.match(/^turns?:([^:/?]+)(?::\d+)?(\?.*)?$/i);
    if (m) {
      const host = m[1];
      const tlsUrl = `turns:${host}:443?transport=tcp`;
      if (tlsUrl.toLowerCase() !== url.toLowerCase()) {
        girisler.push({ urls: tlsUrl, ...kimlik });
      }
    }
  } catch { /* türetme başarısızsa sadece orijinal giriş kullanılır */ }
  return girisler;
}

const RTC_AYARLAR = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    // TURN sunucusu (opsiyonel) — firebase-config.js'de TURN_URL doldurulduysa devreye girer.
    // Doldurulmadıysa sadece STUN ile çalışılır (aynı ağda/Wi-Fi'de sorun olmaz,
    // farklı operatör/mobil veri + Wi-Fi karışık durumlarda bağlantı kurulamayabilir).
    //
    // Kısıtlı ağlar (otel/kurumsal Wi-Fi, bazı operatörler) düz turn:80'i
    // bloklayabildiğinden, TLS üzerinden 443'e giden bir "turns:" girişini de
    // ekliyoruz. Metered.ca gibi servisler genelde her ikisini de destekler.
    // Tek TURN_URL verildiyse ondan otomatik olarak bir 443/TLS türevi üretilir;
    // bağlantı başarı oranını belirgin biçimde artırır.
    ...(TURN_URL && TURN_URL !== "BURAYA_TURN_URL"
      ? turnGirisleriUret(TURN_URL, TURN_KULLANICI, TURN_SIFRE)
      : [])
  ]
};

// Cevapsız arama için zaman aşımı (ms) — bu süre içinde karşı taraf cevap vermezse arama otomatik kapanır.
const ARAMA_ZAMANASIMI_MS = 30000;
let aramaZamanasimiId = null;
// Şu an ekranda "gelen arama" bildirimi gösterilen aramanın id'si (arayan iptal ederse bildirimi kapatmak için).
let gosterilenGelenAramaId = null;

// ---------- Yardımcı DOM kısayolları ----------
const $ = (id) => document.getElementById(id);
const goster = (el) => el.classList.remove("gizli");
const sakla = (el) => el.classList.add("gizli");

// ---------- Tema sistemi (Koyu / Açık / Bohem / Bohem Açık) ----------
const TEMA_ANAHTARI = "kakule-tema";
const GECERLI_TEMALAR = ["koyu", "acik", "bohem", "bohem-acik", "yesil", "yesil-acik"];
// Her temanın PWA çubuk rengi (theme-color) — sıcak tonlar için önemli.
const TEMA_RENK = {
  "koyu": "#14171C",
  "acik": "#F4F1EA",
  "bohem": "#241C15",
  "bohem-acik": "#EDE4D3",
  "yesil": "#0E1613",
  "yesil-acik": "#F0F5F2"
};
function temaYukle() {
  const kayitli = localStorage.getItem(TEMA_ANAHTARI);
  if (GECERLI_TEMALAR.includes(kayitli)) return kayitli;
  const sistemAcikMi = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  return sistemAcikMi ? "acik" : "koyu";
}
function temaUygula(tema) {
  if (!GECERLI_TEMALAR.includes(tema)) tema = "koyu";
  document.documentElement.setAttribute("data-tema", tema);
  const acikMi = tema === "acik" || tema === "bohem-acik";
  const ayIkon = $("tema-ikon-ay");
  const gunesIkon = $("tema-ikon-gunes");
  if (ayIkon && gunesIkon) {
    if (acikMi) { sakla(ayIkon); goster(gunesIkon); }
    else { goster(ayIkon); sakla(gunesIkon); }
  }
  const temaRengiEtiketi = document.querySelector('meta[name="theme-color"]');
  if (temaRengiEtiketi) temaRengiEtiketi.setAttribute("content", TEMA_RENK[tema] || "#14171C");
  // Tema seçicideki aktif kartı işaretle
  document.querySelectorAll(".tema-secim-kart").forEach((k) =>
    k.classList.toggle("aktif", k.dataset.tema === tema));
}
let aktifTema = temaYukle();
temaUygula(aktifTema);
// Üst çubuktaki hızlı toggle: aynı aile içinde koyu<->açık geçişi
// (bohem'deyken bohem-acik'e, klasikteyken acik'e geçer — sıcak/soğuk korunur).
$("tema-degistir-btn")?.addEventListener("click", () => {
  const gecis = {
    "koyu": "acik", "acik": "koyu",
    "bohem": "bohem-acik", "bohem-acik": "bohem",
    "yesil": "yesil-acik", "yesil-acik": "yesil"
  };
  aktifTema = gecis[aktifTema] || "koyu";
  localStorage.setItem(TEMA_ANAHTARI, aktifTema);
  temaUygula(aktifTema);
});
// Tema seçici kartlarından seçim
function temaSec(tema) {
  if (!GECERLI_TEMALAR.includes(tema)) return;
  aktifTema = tema;
  localStorage.setItem(TEMA_ANAHTARI, tema);
  temaUygula(tema);
}
// Tema seçici modalini aç + kartları bağla
$("tema-secici-ac-btn")?.addEventListener("click", () => {
  sakla($("modal-profil"));
  temaUygula(aktifTema); // aktif kartı işaretle
  goster($("modal-tema-secici"));
});
document.querySelectorAll(".tema-secim-kart").forEach((kart) => {
  kart.addEventListener("click", () => temaSec(kart.dataset.tema));
});

function harfBas(ad) {
  return (ad || "?").trim().charAt(0).toUpperCase();
}
function avatarIcerik(veri) {
  if (veri?.profilFotoUrl) return `<img src="${veri.profilFotoUrl}" alt="" />`;
  return harfBas(veri?.ad);
}
function zamanFormatla(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
}
function gunEtiketi(ts) {
  if (!ts) return "";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });
}
function birebirSohbetId(uidA, uidB) {
  return [uidA, uidB].sort().join("_");
}
function rastgeleKod(uzunluk = 8) {
  const harfler = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < uzunluk; i++) s += harfler[Math.floor(Math.random() * harfler.length)];
  return s;
}
function bugunTarihStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const gg = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${gg}`;
}

// ============================================================
// KİMLİK DOĞRULAMA
// ============================================================

$("kayit-ekrani-ac").addEventListener("click", () => {
  sakla($("giris-form")); goster($("kayit-form"));
  sakla($("kayit-ekrani-ac")); goster($("giris-ekrani-ac"));
  sakla($("sifre-sifirla-form")); sakla($("sifre-sifirla-iptal")); sakla($("sifremi-unuttum-ac"));
  hataTemizle();
});
$("giris-ekrani-ac").addEventListener("click", () => {
  goster($("giris-form")); sakla($("kayit-form"));
  goster($("kayit-ekrani-ac")); sakla($("giris-ekrani-ac"));
  sakla($("sifre-sifirla-form")); sakla($("sifre-sifirla-iptal"));
  goster($("sifremi-unuttum-ac"));
  hataTemizle();
});

$("sifremi-unuttum-ac").addEventListener("click", () => {
  sakla($("giris-form")); sakla($("kayit-ekrani-ac")); sakla($("sifremi-unuttum-ac"));
  goster($("sifre-sifirla-form")); goster($("sifre-sifirla-iptal"));
  hataTemizle();
});
$("sifre-sifirla-iptal").addEventListener("click", () => {
  goster($("giris-form")); goster($("kayit-ekrani-ac")); goster($("sifremi-unuttum-ac"));
  sakla($("sifre-sifirla-form")); sakla($("sifre-sifirla-iptal"));
  hataTemizle();
});

$("sifre-sifirla-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hataTemizle();
  const eposta = $("sifirla-eposta").value.trim();
  try {
    await sendPasswordResetEmail(auth, eposta);
    $("auth-basari").textContent = "Sıfırlama bağlantısı e-postana gönderildi. Gelen kutunu (ve spam klasörünü) kontrol et.";
    goster($("auth-basari"));
    sakla($("auth-hata"));
  } catch (err) {
    // Hesap olup olmadığını ifşa etmemek için generic mesaj döndürmek de bir seçenektir,
    // ama Firebase varsayılan davranışı genelde user-not-found döndürür; biz yine de
    // doğrudan ve anlaşılır bir mesaj veriyoruz.
    hataGoster(girisHataMetni(err));
  }
});

function hataGoster(msg) {
  $("auth-hata").textContent = msg;
  goster($("auth-hata"));
  sakla($("auth-basari"));
}
function hataTemizle() {
  sakla($("auth-hata")); sakla($("auth-basari"));
}

$("giris-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hataTemizle();
  const eposta = $("giris-eposta").value.trim();
  const sifre = $("giris-sifre").value;
  try {
    await signInWithEmailAndPassword(auth, eposta, sifre);
  } catch (err) {
    hataGoster(girisHataMetni(err));
  }
});

$("kayit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  hataTemizle();
  const kod = $("kayit-davet-kodu").value.trim().toUpperCase();
  const ad = $("kayit-ad").value.trim();
  const dogumTarihi = $("kayit-dogum-tarihi").value;
  const eposta = $("kayit-eposta").value.trim();
  const sifre = $("kayit-sifre").value;

  if (!dogumTarihi) { hataGoster("Doğum tarihini girmen gerekiyor."); return; }

  try {
    // Davetiye kodu geçerli mi? (Kuruluş anahtarı = ilk admin için her zaman geçerli)
    let davetRef = null;
    if (kod !== KURULUS_ANAHTARI.toUpperCase()) {
      davetRef = doc(db, "davetler", kod);
      const davetSnap = await getDoc(davetRef);
      if (!davetSnap.exists() || davetSnap.data().kullanildi) {
        hataGoster("Davetiye kodu geçersiz veya zaten kullanılmış.");
        return;
      }
      const exp = davetSnap.data().expiresAt;
      if (exp && Date.now() > exp) {
        hataGoster("Bu davetiye kodunun süresi dolmuş. Aileden yeni bir kod isteyin.");
        return;
      }
    }

    const cred = await createUserWithEmailAndPassword(auth, eposta, sifre);
    const rolAtama = (kod === KURULUS_ANAHTARI.toUpperCase()) ? "admin" : "uye";

    // ÖNEMLİ SIRA: Kullanıcı belgesini yazmadan ÖNCE daveti bu uid ile
    // "kullanıldı" olarak işaretliyoruz. Böylece firestore.rules, kullanıcı
    // belgesi oluşturulurken ilgili davetin gerçekten bu uid tarafından
    // tüketildiğini get() ile doğrulayabiliyor (davetsiz hesap açılamaz).
    if (davetRef) {
      await updateDoc(davetRef, { kullanildi: true, kullananUid: cred.user.uid, kullananAd: ad });
    }

    await setDoc(doc(db, "kullanicilar", cred.user.uid), {
      ad, eposta, dogumTarihi,
      rol: rolAtama,
      // Hangi davetle katıldığı — kural tarafında davetler/{davetKodu} belgesine
      // bakıp kullananUid == bu uid mi diye doğrulamak için saklanıyor.
      // Kuruluş anahtarıyla açılan ilk admin için değer "KURULUS" olur.
      davetKodu: (rolAtama === "admin") ? "KURULUS" : kod,
      cevrimici: true,
      onboardingTamamlandi: false,
      sonGorulme: serverTimestamp(),
      olusturulmaZamani: serverTimestamp()
    });

    // İlk admin (kuruluş anahtarıyla) oluştuktan hemen sonra kuruluş kilidini
    // yazıyoruz — bundan sonra firestore.rules, kuruluş anahtarıyla yeni bir
    // admin hesabı açılmasına asla izin vermeyecek (bkz. firestore.rules
    // içindeki /ayarlar/kurulus açıklaması).
    if (rolAtama === "admin") {
      await setDoc(doc(db, "ayarlar", "kurulus"), { kullanildi: true }).catch(() => {});
    }
    // onAuthStateChanged geri çağırımı uygulamaya geçişi tetikleyecek
  } catch (err) {
    hataGoster(girisHataMetni(err));
  }
});

function girisHataMetni(err) {
  const kod = err.code || "";
  if (kod.includes("email-already-in-use")) return "Bu e-posta zaten kayıtlı.";
  if (kod.includes("invalid-credential") || kod.includes("wrong-password") || kod.includes("user-not-found"))
    return "E-posta ya da şifre hatalı.";
  if (kod.includes("weak-password")) return "Şifre en az 6 karakter olmalı.";
  if (kod.includes("invalid-email")) return "Geçersiz e-posta adresi.";
  return "Bir hata oluştu: " + (err.message || kod);
}

$("cikis-btn").addEventListener("click", async () => {
  if (suankiKullanici) {
    await updateDoc(doc(db, "kullanicilar", suankiKullanici.uid), {
      cevrimici: false, sonGorulme: serverTimestamp()
    }).catch(() => {});
  }
  await signOut(auth);
});

onAuthStateChanged(auth, async (user) => {
  if (user) {
    const snap = await getDoc(doc(db, "kullanicilar", user.uid));
    const veri = snap.exists() ? snap.data() : { ad: user.email };

    // Admin tarafından dondurulmuş bir hesapsa, hemen oturumu kapat ve
    // giriş ekranına geri gönder — uygulamaya erişemesin.
    if (veri.dondurulmus === true) {
      await signOut(auth);
      hataGoster("Bu hesap aile yöneticisi tarafından dondurulmuş. Erişim için aile yöneticinize başvurun.");
      return;
    }

    suankiKullanici = { uid: user.uid, ad: veri.ad, eposta: user.email, rol: veri.rol || "uye" };
    await updateDoc(doc(db, "kullanicilar", user.uid), { cevrimici: true }).catch(() => {});

    sakla($("auth-sayfa"));
    goster($("uygulama"));
    uygulamayiBaslat();
  } else {
    suankiKullanici = null;
    goster($("auth-sayfa"));
    sakla($("uygulama"));
    if (mesajAbonelik) mesajAbonelik();
    if (sohbetlerAbonelik) sohbetlerAbonelik();
    if (kendiProfilAbonelik) { kendiProfilAbonelik(); kendiProfilAbonelik = null; }
  }
});

window.addEventListener("beforeunload", () => {
  if (suankiKullanici) {
    updateDoc(doc(db, "kullanicilar", suankiKullanici.uid), {
      cevrimici: false, sonGorulme: serverTimestamp()
    }).catch(() => {});
  }
});

// ============================================================
// UYGULAMA BAŞLATMA
// ============================================================
function uygulamayiBaslat() {
  uyeleriDinle();
  kendiProfilimiDinle();
  sohbetleriDinle();
  gelenAramalariDinle();
  bulusmaDavetleriniDinle();
  defterListeleriniDinle();
  statuleriDinle();
  workerAnahtariniYukle();
  pushAbonelikBaslat();
  konumIzniIste(true);
  eskiStatuleriSupur();
  adminButonuGuncelle();
  onboardingKontrolEt();
}

// ---------- Aile üyelerini dinle ----------
let dogumGunuKontrolYapildi = false;
function uyeleriDinle() {
  onSnapshot(collection(db, "kullanicilar"), (snap) => {
    tumUyeler = {};
    snap.forEach((d) => { tumUyeler[d.id] = d.data(); });
    kisiListesiCiz();
    dogumGunuListesiCiz();
    sohbetBasligiGuncelle();

    if (!dogumGunuKontrolYapildi) {
      dogumGunuKontrolYapildi = true;
      dogumGunuKontrolEt();
    }
  });
}

// ---------- Kendi profilimi canlı dinle ----------
// Admin, biri oturum açmışKEN o kişiyi dondurursa ya da rolünü değiştirirse,
// bu değişikliğin sayfa yenilenmeden ANINDA etkili olması için ayrıca kendi
// belgemizi de dinliyoruz. Böylece:
//  - Dondurulan kişi anında oturumdan atılır (sadece mesaj göndermesi
//    engellenmiş kalmaz, tüm erişimi kesilir).
//  - Admin yapılan/admin'likten alınan kişinin admin paneli düğmesi anında
//    görünür/gizlenir.
let kendiProfilAbonelik = null;
function kendiProfilimiDinle() {
  if (kendiProfilAbonelik) kendiProfilAbonelik();
  kendiProfilAbonelik = onSnapshot(doc(db, "kullanicilar", suankiKullanici.uid), (snap) => {
    if (!snap.exists()) return;
    const veri = snap.data();

    if (veri.dondurulmus === true) {
      alert("Hesabın aile yöneticisi tarafından dondurulmuş. Erişimin sonlandırılıyor.");
      signOut(auth);
      return;
    }

    if (veri.rol !== suankiKullanici.rol) {
      suankiKullanici.rol = veri.rol || "uye";
      adminButonuGuncelle();
    }
  });
}

function kisiListesiCiz() {
  const kapsayici = $("kisi-listesi");
  kapsayici.innerHTML = "";
  const digerleri = Object.entries(tumUyeler).filter(([uid]) => uid !== suankiKullanici?.uid);

  if (digerleri.length === 0) {
    kapsayici.innerHTML = `<div class="bos-liste"><img src="icons/gradyan/kisi.png" alt="" style="width:64px;height:64px;opacity:.85;margin-bottom:12px;" /><br>Henüz başka aile üyesi yok.<br>Sağ üstten davetiye oluşturup paylaşabilirsin.</div>`;
    return;
  }

  digerleri
    .sort((a, b) => (a[1].ad || "").localeCompare(b[1].ad || ""))
    .forEach(([uid, veri]) => {
      const oge = document.createElement("div");
      oge.className = "sohbet-ogesi";
      const durum = cevrimiciDurumGoster(uid, veri);
      oge.innerHTML = `
        <div class="avatar">${avatarIcerik(veri)}${durum.nokta ? '<span class="cevrimici-nokta"></span>' : ""}</div>
        <div class="sohbet-bilgi">
          <div class="ad">${kacir(veri.ad)}</div>
          <div class="onizleme">${durum.metin}</div>
        </div>`;
      oge.addEventListener("click", () => birebirSohbetAc(uid));
      kapsayici.appendChild(oge);
    });
}

function kacir(metin) {
  const d = document.createElement("div");
  d.textContent = metin ?? "";
  return d.innerHTML;
}

// Bir üyenin çevrimiçi/son görülme bilgisini, KENDİ gizlilik ayarını dikkate
// alarak gösterilecek metne çevirir. Kişi kendi durumunu her zaman görür;
// başkaları, ilgili kişi "Çevrimiçi durumumu gizle"yi açtıysa hiçbir şey
// göremez (ne "Çevrimiçi" ne de "Son görülme").
function cevrimiciDurumGoster(uid, veri) {
  const kendisiMi = uid === suankiKullanici?.uid;
  if (!kendisiMi && veri?.gizlilik?.sonGorulmeGizli) {
    return { metin: "", nokta: false, gizli: true };
  }
  if (veri?.cevrimici) return { metin: "Çevrimiçi", nokta: true, gizli: false };
  return {
    metin: "Son görülme: " + (veri?.sonGorulme ? zamanFormatla(veri.sonGorulme) : "—"),
    nokta: false,
    gizli: false
  };
}

// ---------- Doğum günleri ----------
function dogumGunuListesiCiz() {
  const kapsayici = $("dogumgunu-listesi");
  if (!kapsayici) return;
  kapsayici.innerHTML = "";

  const herkes = Object.entries(tumUyeler); // kullanıcının kendisi de dahil
  const bugun = new Date();
  bugun.setHours(0, 0, 0, 0);

  const liste = herkes
    .filter(([, veri]) => !!veri.dogumTarihi)
    .map(([uid, veri]) => {
      const dt = new Date(veri.dogumTarihi + "T00:00:00");
      const ay = dt.getMonth();
      const gun = dt.getDate();
      let siradaki = new Date(bugun.getFullYear(), ay, gun);
      if (siradaki < bugun) siradaki = new Date(bugun.getFullYear() + 1, ay, gun);
      const kalanGun = Math.round((siradaki - bugun) / 86400000);
      const yeniYas = siradaki.getFullYear() - dt.getFullYear();
      return { uid, veri, ay, gun, kalanGun, yeniYas };
    })
    .sort((a, b) => a.kalanGun - b.kalanGun);

  if (liste.length === 0) {
    kapsayici.innerHTML = `<div class="bos-liste">Henüz doğum tarihi girilmiş kimse yok.<br>Profilinden doğum tarihini ekleyebilirsin.</div>`;
    return;
  }

  const AY_ADLARI = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];

  liste.forEach(({ uid, veri, gun, ay, kalanGun, yeniYas }) => {
    const benMi = uid === suankiKullanici?.uid;
    let etiket;
    if (kalanGun === 0) etiket = "🎉 Bugün!";
    else if (kalanGun === 1) etiket = "Yarın";
    else etiket = `${kalanGun} gün sonra`;

    const oge = document.createElement("div");
    oge.className = "sohbet-ogesi";
    oge.innerHTML = `
      <div class="avatar">${avatarIcerik(veri)}</div>
      <div class="sohbet-bilgi">
        <div class="ad">${kacir(veri.ad)}${benMi ? " (sen)" : ""}</div>
        <div class="onizleme">${gun} ${AY_ADLARI[ay]} — ${yeniYas}. yaş</div>
      </div>
      <div class="sohbet-meta">
        <div class="zaman">${etiket}</div>
      </div>`;
    kapsayici.appendChild(oge);
  });
}

// ---------- Doğum günü otomatik kutlama (push + sohbet mesajı) ----------
// Uygulama her açıldığında (kullanıcı listesi ilk geldiğinde) bugün doğum günü
// olan birileri var mı diye bakar. "dogumGunuKutlamalari" koleksiyonunda
// her doğum günü+gün için tek bir kayıt oluşturulabildiğinden (Firestore'da
// belge zaten varsa ikinci oluşturma denemesi başarısız olur), aynı gün
// birden çok aile üyesi uygulamayı açsa bile kutlama sadece bir kez tetiklenir.
async function dogumGunuKontrolEt() {
  const bugun = new Date();
  const ay = bugun.getMonth();
  const gun = bugun.getDate();
  const bugunStr = bugunTarihStr();

  for (const [uid, veri] of Object.entries(tumUyeler)) {
    if (!veri.dogumTarihi) continue;
    const dt = new Date(veri.dogumTarihi + "T00:00:00");
    if (dt.getMonth() !== ay || dt.getDate() !== gun) continue;

    const kutlamaRef = doc(db, "dogumGunuKutlamalari", `${uid}_${bugunStr}`);
    try {
      const mevcut = await getDoc(kutlamaRef);
      if (mevcut.exists()) continue; // bugün için zaten kutlandı
      await setDoc(kutlamaRef, {
        uid, tetikleyenUid: suankiKullanici.uid, zaman: serverTimestamp()
      });
      await dogumGunuKutla(uid, veri);
    } catch (err) {
      console.warn("Doğum günü kontrolü başarısız:", err.message);
    }
  }
}

async function dogumGunuKutla(uid, veri) {
  // 1) Push bildirimi: kendisi hariç tüm aile üyelerine
  const aliciUidler = Object.keys(tumUyeler).filter((u) => u !== uid);
  if (aliciUidler.length) {
    pushBildirimGonder(
      aliciUidler,
      "🎂 Bugün doğum günü!",
      `${veri.ad}'in bugün doğum günü! Kutlamayı unutma 🎉`,
      "dogumgunu-" + uid
    ).catch(() => {});
  }

  // 2) Doğum günü kişisinin de yer aldığı, kendimin de üyesi olduğum sohbetlere
  //    otomatik kutlama mesajı düş (Firestore kuralları bir sohbete sadece o
  //    sohbetin üyesi yazabildiği için, sadece ortak olduğum sohbetlere yazabilirim).
  try {
    const sohbetlerSnap = await getDocs(
      query(collection(db, "sohbetler"), where("uyeler", "array-contains", uid))
    );
    for (const sohbetDoc of sohbetlerSnap.docs) {
      const sohbetVeri = sohbetDoc.data();
      if (!(sohbetVeri.uyeler || []).includes(suankiKullanici.uid)) continue; // ortak değilim, atla

      const sohbetId = sohbetDoc.id;
      await addDoc(collection(db, "sohbetler", sohbetId, "mesajlar"), {
        gonderenUid: suankiKullanici.uid,
        tip: "dogumgunu",
        dogumGunuUid: uid,
        dogumGunuAd: veri.ad,
        metin: `🎉 Bugün ${veri.ad}'in doğum günü! İyi ki doğdun ${veri.ad}! 🎂`,
        zaman: serverTimestamp()
      });
      await updateDoc(doc(db, "sohbetler", sohbetId), {
        sonMesaj: `🎂 ${veri.ad}'in doğum günü!`,
        sonMesajZamani: serverTimestamp()
      }).catch(() => {});
    }
  } catch (err) {
    console.warn("Doğum günü kutlama mesajı eklenemedi:", err.message);
  }
}

// ---------- Sekmeler ----------
document.querySelectorAll(".sekme").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".sekme").forEach((b) => b.classList.remove("aktif"));
    btn.classList.add("aktif");
    sakla($("sohbet-listesi")); sakla($("kisi-listesi")); sakla($("defter-listesi")); sakla($("dogumgunu-listesi"));
    if (btn.dataset.sekme === "sohbetler") {
      goster($("sohbet-listesi"));
    } else if (btn.dataset.sekme === "kisiler") {
      goster($("kisi-listesi"));
    } else if (btn.dataset.sekme === "defter") {
      goster($("defter-listesi"));
    } else if (btn.dataset.sekme === "dogumgunleri") {
      dogumGunuListesiCiz();
      goster($("dogumgunu-listesi"));
    }
  });
});

// ============================================================
// SOHBET LİSTESİ
// ============================================================
let sohbetlerCache = [];

function sohbetleriDinle() {
  const q = query(
    collection(db, "sohbetler"),
    where("uyeler", "array-contains", suankiKullanici.uid),
    orderBy("sonMesajZamani", "desc")
  );
  let ilkYukleme = true;
  let oncekiOkunmamisHaritasi = {};
  sohbetlerAbonelik = onSnapshot(q, (snap) => {
    sohbetlerCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Açık olan sohbetin sayacı her zaman 0 sayılır (zaten okunuyor) — gerçek
    // belgeyi de sıfırla ki sayaç sunucu tarafında da yanlışlıkla birikmesin.
    if (aktifSohbetId) {
      const acikSohbet = sohbetlerCache.find((x) => x.id === aktifSohbetId);
      if (acikSohbet && okunmamisSayisi(acikSohbet) > 0) {
        if (acikSohbet.okunmamis) acikSohbet.okunmamis[suankiKullanici.uid] = 0;
        updateDoc(doc(db, "sohbetler", aktifSohbetId), {
          [`okunmamis.${suankiKullanici.uid}`]: 0
        }).catch(() => {});
      }
    }

    const yeniHarita = {};
    sohbetlerCache.forEach((s) => { yeniHarita[s.id] = okunmamisSayisi(s); });
    const artanSohbetIdler = Object.keys(yeniHarita)
      .filter((id) => yeniHarita[id] > (oncekiOkunmamisHaritasi[id] || 0));
    oncekiOkunmamisHaritasi = yeniHarita;

    sohbetListesiCiz();
    yazmaGostergesiGuncelle();
    bildirimRozetiGuncelle();
    sabitBannerGuncelle();

    if (!ilkYukleme && artanSohbetIdler.length && sesCalinmaliMi(artanSohbetIdler)) {
      bildirimSesiCal();
    }
    ilkYukleme = false;
  });
}

// ---------- Okunmamış mesaj sayacı / bildirim rozeti ----------
function okunmamisSayisi(s) {
  return (s?.okunmamis && s.okunmamis[suankiKullanici.uid]) || 0;
}
function okunmamisToplamHesapla(liste) {
  return liste.reduce((toplam, s) => toplam + okunmamisSayisi(s), 0);
}

function bildirimRozetiGuncelle() {
  const toplam = okunmamisToplamHesapla(sohbetlerCache.filter((s) => !sohbetGizliMi(s)));

  const sekmeRozet = document.querySelector('.sekme[data-sekme="sohbetler"] .sekme-rozet');
  if (sekmeRozet) {
    if (toplam > 0) { sekmeRozet.textContent = toplam > 99 ? "99+" : String(toplam); goster(sekmeRozet); }
    else sakla(sekmeRozet);
  }

  document.title = toplam > 0 ? `(${toplam > 99 ? "99+" : toplam}) Kakule` : "Kakule";

  if ("setAppBadge" in navigator) {
    if (toplam > 0) navigator.setAppBadge(toplam).catch(() => {});
    else navigator.clearAppBadge().catch(() => {});
  }
}

// ---------- Bildirim / sessize alma yardımcıları ----------
// uid'si verilen kişi belirtilen sohbet için (ya da genel olarak) bildirim/ses almak istemiyor mu?
function bildirimSessizMi(uid, sohbetId) {
  const veri = tumUyeler[uid];
  if (!veri) return false;
  if (veri.bildirimAyarlari?.uygulamaSessiz) return true;
  if (sohbetId && (veri.sessizeAlinanSohbetler || []).includes(sohbetId)) return true;
  return false;
}

// Kendi cihazımızda, artan okunmamış sayısına sahip sohbetlerden en az biri
// için ses çalınmalı mı? (genel ses ayarı + uygulama geneli/sohbet bazlı sessize alma)
function sesCalinmaliMi(sohbetIdler) {
  const ayar = tumUyeler[suankiKullanici?.uid]?.bildirimAyarlari || {};
  if (ayar.sesAcik === false) return false;
  if (ayar.uygulamaSessiz) return false;
  return sohbetIdler.some((id) => !bildirimSessizMi(suankiKullanici.uid, id));
}

// Kısa bildirim sesleri — Web Audio API ile, harici dosya gerektirmez.
// secimZorla verilirse (ör. ayarlardaki "dinle" önizleme butonu) kullanıcının
// kayıtlı tercihi yerine doğrudan o ses çalınır.
let sesBaglami = null;
const BILDIRIM_SES_DESENLERI = {
  ting:    { dalga: "sine",     notalar: [[880, 0, 0.18], [1318.5, 0.09, 0.18]] },
  pop:     { dalga: "triangle", notalar: [[523, 0, 0.2]] },
  zil:     { dalga: "sine",     notalar: [[1046.5, 0, 0.15], [1318.5, 0.08, 0.15], [1568, 0.16, 0.16]] },
  yumusak: { dalga: "sine",     notalar: [[660, 0, 0.16], [660, 0.18, 0.12]] }
};
function bildirimSesiCal(secimZorla) {
  try {
    sesBaglami = sesBaglami || new (window.AudioContext || window.webkitAudioContext)();
    if (sesBaglami.state === "suspended") sesBaglami.resume();
    const secim = secimZorla || tumUyeler[suankiKullanici?.uid]?.bildirimAyarlari?.sesSecimi || "ting";
    const desen = BILDIRIM_SES_DESENLERI[secim] || BILDIRIM_SES_DESENLERI.ting;
    const simdi = sesBaglami.currentTime;
    desen.notalar.forEach(([frekans, gecikme, kazancTepe]) => {
      const osc = sesBaglami.createOscillator();
      const kazanc = sesBaglami.createGain();
      osc.type = desen.dalga;
      osc.frequency.value = frekans;
      kazanc.gain.setValueAtTime(0, simdi + gecikme);
      kazanc.gain.linearRampToValueAtTime(kazancTepe, simdi + gecikme + 0.01);
      kazanc.gain.exponentialRampToValueAtTime(0.001, simdi + gecikme + 0.3);
      osc.connect(kazanc);
      kazanc.connect(sesBaglami.destination);
      osc.start(simdi + gecikme);
      osc.stop(simdi + gecikme + 0.32);
    });
  } catch (err) {
    console.warn("Bildirim sesi çalınamadı:", err.message);
  }
}

function sohbetListesiCiz() {
  const kapsayici = $("sohbet-listesi");
  kapsayici.innerHTML = "";

  // "Sohbeti sil" ile kendi listesinden gizlenen sohbetleri çıkar (bkz. sohbetGizliMi).
  const gorunurSohbetler = sohbetlerCache.filter((s) => !sohbetGizliMi(s));

  if (gorunurSohbetler.length === 0) {
    kapsayici.innerHTML = `<div class="bos-liste">Henüz sohbet yok.<br>"Aile Üyeleri" sekmesinden birine yaz veya yeni grup kur.</div>`;
    return;
  }

  // Sabitlenen sohbetler üstte. Kullanıcının kendi sabit listesi profilinde tutulur.
  const sabitler = tumUyeler[suankiKullanici.uid]?.sabitlenenSohbetler || [];
  const sirali = [...gorunurSohbetler].sort((a, b) => {
    const aSabit = sabitler.includes(a.id) ? 1 : 0;
    const bSabit = sabitler.includes(b.id) ? 1 : 0;
    if (aSabit !== bSabit) return bSabit - aSabit; // sabitler önce
    const az = a.sonMesajZamani?.toMillis?.() || 0;
    const bz = b.sonMesajZamani?.toMillis?.() || 0;
    return bz - az;
  });

  sirali.forEach((s) => {
    const grup = s.tip === "grup";
    let ad, icerikAvatar;
    if (grup) {
      ad = s.ad || "Grup";
      icerikAvatar = s.grupFotoUrl ? `<img src="${s.grupFotoUrl}" alt="" />` : harfBas(ad);
    } else {
      const karsiUid = s.uyeler.find((u) => u !== suankiKullanici.uid);
      ad = tumUyeler[karsiUid]?.ad || "Üye";
      icerikAvatar = avatarIcerik(tumUyeler[karsiUid]);
    }
    const oge = document.createElement("div");
    oge.className = "sohbet-ogesi" + (s.id === aktifSohbetId ? " secili" : "");
    const okunmamis = okunmamisSayisi(s);
    const sessiz = (tumUyeler[suankiKullanici.uid]?.sessizeAlinanSohbetler || []).includes(s.id);
    const sabit = sabitler.includes(s.id);
    oge.innerHTML = `
      <div class="avatar ${grup ? "grup" : ""}">${icerikAvatar}</div>
      <div class="sohbet-bilgi">
        <div class="ad">${sabit ? '<span title="Sabitlendi" style="color:var(--alev);">📌</span> ' : ""}${kacir(ad)}${sessiz ? ' <span title="Sessize alındı" style="opacity:.55;">🔕</span>' : ""}</div>
        <div class="onizleme">${kacir(s.sonMesaj || "Henüz mesaj yok")}</div>
      </div>
      <div class="sohbet-meta">
        <div class="zaman">${s.sonMesajZamani ? zamanFormatla(s.sonMesajZamani) : ""}</div>
        ${okunmamis > 0 ? `<div class="rozet">${okunmamis > 99 ? "99+" : okunmamis}</div>` : ""}
      </div>`;
    oge.addEventListener("click", () => sohbetAc(s.id, s.tip, grup ? null : s.uyeler.find((u) => u !== suankiKullanici.uid)));
    // Uzun basma (mobil) / sağ tık (masaüstü) → sohbet yönetim menüsü
    let basmaZaman;
    oge.addEventListener("pointerdown", () => { basmaZaman = setTimeout(() => sohbetYonetimAc(s), 500); });
    oge.addEventListener("pointerup", () => clearTimeout(basmaZaman));
    oge.addEventListener("pointerleave", () => clearTimeout(basmaZaman));
    oge.addEventListener("contextmenu", (e) => { e.preventDefault(); sohbetYonetimAc(s); });
    kapsayici.appendChild(oge);
  });
}

// Sohbet yönetim menüsü: sabitle/sabitlemeyi kaldır, sessize al/aç
function sohbetYonetimAc(s) {
  const sabitler = tumUyeler[suankiKullanici.uid]?.sabitlenenSohbetler || [];
  const sessizler = tumUyeler[suankiKullanici.uid]?.sessizeAlinanSohbetler || [];
  const sabit = sabitler.includes(s.id);
  const sessiz = sessizler.includes(s.id);
  $("sohbet-yonetim-sabitle").textContent = sabit ? "📌 Sabitlemeyi kaldır" : "📌 Sabitle";
  $("sohbet-yonetim-sessize").textContent = sessiz ? "🔔 Sessizi kaldır" : "🔕 Sessize al";
  $("modal-sohbet-yonetim").dataset.sohbetId = s.id;
  // "Sohbeti sil" (kendim için gizle) sadece birebir sohbetlerde gösterilir;
  // gruplar için bu menüde bir silme seçeneği yok (gruptan ayrılma ayrı akış).
  const silBtn = $("sohbet-yonetim-sil");
  if (silBtn) {
    if (s.tip === "grup") sakla(silBtn); else goster(silBtn);
  }
  goster($("modal-sohbet-yonetim"));
}

async function sohbetSabitleToggle() {
  const id = $("modal-sohbet-yonetim").dataset.sohbetId;
  const sabitler = tumUyeler[suankiKullanici.uid]?.sabitlenenSohbetler || [];
  const sabit = sabitler.includes(id);
  try {
    await updateDoc(doc(db, "kullanicilar", suankiKullanici.uid), {
      sabitlenenSohbetler: sabit ? arrayRemove(id) : arrayUnion(id)
    });
  } catch (e) { alert("İşlem başarısız: " + e.message); }
  sakla($("modal-sohbet-yonetim"));
}

async function sohbetSessizeToggle() {
  const id = $("modal-sohbet-yonetim").dataset.sohbetId;
  const sessizler = tumUyeler[suankiKullanici.uid]?.sessizeAlinanSohbetler || [];
  const sessiz = sessizler.includes(id);
  try {
    await updateDoc(doc(db, "kullanicilar", suankiKullanici.uid), {
      sessizeAlinanSohbetler: sessiz ? arrayRemove(id) : arrayUnion(id)
    });
  } catch (e) { alert("İşlem başarısız: " + e.message); }
  sakla($("modal-sohbet-yonetim"));
}

// "Sohbeti sil" (SADECE KENDİM İÇİN): mesajları kimseden silmiyoruz — karşı
// tarafın kopyası ve Firestore'daki asıl veri olduğu gibi kalır. Bunun yerine
// kendi profil belgemize "bu sohbeti şu ana kadar sildim" damgası vuruyoruz.
// Sohbet listesi çizilirken bu damgadan ESKİ olan sohbetler gizlenir; damgadan
// SONRA gelen yeni bir mesaj olursa sohbet otomatik olarak listede geri belirir
// (WhatsApp'taki "sohbeti sil" davranışına benzer).
async function sohbetSilBenimIcin() {
  const id = $("modal-sohbet-yonetim").dataset.sohbetId;
  if (!id) return;
  const onay = confirm(
    "Bu sohbeti kendi listenden silmek istediğine emin misin?\n\n" +
    "Karşı taraf sohbeti ve mesajları görmeye devam eder. Sen tekrar mesaj " +
    "gönderirsen ya da karşı taraftan yeni mesaj gelirse sohbet listende yeniden görünür."
  );
  if (!onay) return;
  try {
    await updateDoc(doc(db, "kullanicilar", suankiKullanici.uid), {
      [`silinenSohbetler.${id}`]: Date.now()
    });
  } catch (e) {
    alert("İşlem başarısız: " + e.message);
    sakla($("modal-sohbet-yonetim"));
    return;
  }
  // Şu an bu sohbet açıksa karşılama ekranına dön.
  if (aktifSohbetId === id) {
    aktifSohbetId = null;
    aktifSohbetTipi = null;
    aktifSohbetKarsi = null;
    sakla($("sohbet-aktif"));
    goster($("karsilama-ekrani"));
    if (window.innerWidth <= 760) {
      $("panel-liste").classList.remove("gizli-mobil");
      $("panel-sohbet").classList.add("gizli-mobil");
    }
  }
  sakla($("modal-sohbet-yonetim"));
}

// Bir sohbetin, bu cihazdaki kullanıcı için "silinmiş" (gizlenmiş) sayılıp
// sayılmadığını hesaplar: silme damgasından sonra yeni mesaj gelmediyse gizlidir.
function sohbetGizliMi(s) {
  const silinenler = tumUyeler[suankiKullanici?.uid]?.silinenSohbetler || {};
  const silinmeZamani = silinenler[s.id];
  if (!silinmeZamani) return false;
  const sonMesajMs = s.sonMesajZamani?.toMillis?.() || 0;
  return sonMesajMs <= silinmeZamani;
}

// ---------- Birebir sohbet aç (yoksa oluştur) ----------
async function birebirSohbetAc(karsiUid) {
  const id = birebirSohbetId(suankiKullanici.uid, karsiUid);
  const ref = doc(db, "sohbetler", id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      tip: "birebir",
      uyeler: [suankiKullanici.uid, karsiUid],
      sonMesaj: "",
      sonMesajZamani: serverTimestamp(),
      olusturulmaZamani: serverTimestamp()
    });
  }
  sohbetAc(id, "birebir", karsiUid);
  document.querySelector('.sekme[data-sekme="sohbetler"]').click();
}

// ============================================================
// AKTİF SOHBET / MESAJLAR
// ============================================================
function sohbetAc(id, tip, karsiUid) {
  aktifSohbetId = id;
  aktifSohbetTipi = tip;
  aktifSohbetKarsi = karsiUid || null;
  duzenlenenMesajId = null;
  sakla($("duzenleme-bandi"));
  yanitlaIptal();
  if (aramaAktif) aramaKapat();

  sakla($("karsilama-ekrani"));
  goster($("sohbet-aktif"));
  $("sohbet-aktif").style.display = "flex";

  if (window.innerWidth <= 760) {
    $("panel-liste").classList.add("gizli-mobil");
    $("panel-sohbet").classList.remove("gizli-mobil");
  }

  if (tip === "grup") {
    goster($("grup-uyeler-btn"));
  } else {
    sakla($("grup-uyeler-btn"));
  }

  sohbetBasligiGuncelle();
  sabitBannerGuncelle();
  mesajlariDinle(id);
  sohbetListesiCiz();

  updateDoc(doc(db, "sohbetler", id), {
    [`okunmamis.${suankiKullanici.uid}`]: 0
  }).catch(() => {});
  bildirimRozetiGuncelle();
}

$("geri-btn").addEventListener("click", () => {
  $("panel-liste").classList.remove("gizli-mobil");
  $("panel-sohbet").classList.add("gizli-mobil");
});

function sohbetBasligiGuncelle() {
  if (!aktifSohbetId) return;
  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  if (aktifSohbetTipi === "grup") {
    const ad = s?.ad || "Grup";
    $("sohbet-baslik-ad").textContent = ad;
    $("sohbet-avatar").innerHTML = s?.grupFotoUrl ? `<img src="${s.grupFotoUrl}" alt="" />` : harfBas(ad);
    $("sohbet-avatar").className = "avatar grup";
    const uyeSayi = s?.uyeler?.length || 0;
    $("sohbet-baslik-durum").textContent = uyeSayi + " üye";
  } else {
    const veri = tumUyeler[aktifSohbetKarsi];
    $("sohbet-baslik-ad").textContent = veri?.ad || "Üye";
    $("sohbet-avatar").innerHTML = avatarIcerik(veri);
    $("sohbet-avatar").className = "avatar";
    const durum = cevrimiciDurumGoster(aktifSohbetKarsi, veri);
    $("sohbet-baslik-durum").textContent = durum.gizli ? "" : (durum.metin === "Çevrimiçi" ? "Çevrimiçi" : "Çevrimdışı");
  }
  yazmaGostergesiGuncelle();
  sohbetSessizDugmesiGuncelle();
}

// ---------- "Yazıyor..." göstergesi ----------
let sonYazmaBildirim = 0;
function bildirYaziyorum() {
  if (!aktifSohbetId) return;
  const simdi = Date.now();
  if (simdi - sonYazmaBildirim < 1500) return;
  sonYazmaBildirim = simdi;
  updateDoc(doc(db, "sohbetler", aktifSohbetId), {
    [`yazanlar.${suankiKullanici.uid}`]: simdi
  }).catch(() => {});
}

function yazmaGostergesiGuncelle() {
  const el = $("yazma-gostergesi");
  if (!aktifSohbetId) { el.textContent = ""; return; }
  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  if (!s || !s.yazanlar) { el.textContent = ""; return; }
  const simdi = Date.now();
  const yazanlar = Object.entries(s.yazanlar)
    .filter(([uid, ts]) => uid !== suankiKullanici.uid && simdi - ts < 3000)
    .map(([uid]) => uid);
  if (yazanlar.length === 0) { el.textContent = ""; return; }
  if (aktifSohbetTipi === "grup") {
    const adlar = yazanlar.map((u) => tumUyeler[u]?.ad || "Üye");
    el.textContent = adlar.join(", ") + (adlar.length > 1 ? " yazıyorlar..." : " yazıyor...");
  } else {
    el.textContent = "yazıyor...";
  }
}
setInterval(yazmaGostergesiGuncelle, 1200);

let mesajlarCache = [];
let ilkMesajYuklemesi = true;   // sohbet açıldığında ilk snapshot'ta tam çizim yap
let duzenlenenMesajId = null;

// ---------- Sohbette mesaj arama ----------
let aramaAktif = false;
let aramaSorgu = "";
let aramaEslesenMesajIdler = [];
let aramaAktifIndeks = -1;

function regexKacir(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
// Mesaj metnindeki "@Ad" bahsetmelerini, grup üyeleriyle eşleştirip vurgular.
// Beni etiketleyen bahsetme "bana" sınıfıyla ayrıca işaretlenir.
function bahsetmeVurgula(escapedMetin, sohbet) {
  if (!sohbet || sohbet.tip !== "grup" || !sohbet.uyeler) return escapedMetin;
  let sonuc = escapedMetin;
  sohbet.uyeler.forEach((uid) => {
    const ad = tumUyeler[uid]?.ad;
    if (!ad) return;
    const adEscaped = kacir(ad);
    const rx = new RegExp("@(" + regexKacir(adEscaped) + ")(?![\\wçÇğĞıİöÖşŞüÜ])", "g");
    const benMi = uid === suankiKullanici.uid;
    sonuc = sonuc.replace(rx, `<span class="bahsetme-vurgu${benMi ? " bana" : ""}">@$1</span>`);
  });
  return sonuc;
}
function aramaMetniVurgula(metin) {
  let escaped = kacir(metin);
  escaped = bahsetmeVurgula(escaped, sohbetlerCache.find((x) => x.id === aktifSohbetId));
  if (!aramaSorgu) return escaped;
  const rx = new RegExp("(" + regexKacir(aramaSorgu) + ")", "gi");
  return escaped.replace(rx, '<mark class="arama-vurgu">$1</mark>');
}

$("mesaj-arama-btn").addEventListener("click", () => {
  if (aramaAktif) {
    aramaKapat();
  } else {
    aramaAktif = true;
    goster($("mesaj-arama-cubugu"));
    $("mesaj-arama-input").value = "";
    mesajAlaniCiz(mesajlarCache);
    $("mesaj-arama-input").focus();
  }
});

function aramaKapat() {
  aramaAktif = false;
  aramaSorgu = "";
  aramaEslesenMesajIdler = [];
  aramaAktifIndeks = -1;
  sakla($("mesaj-arama-cubugu"));
  $("mesaj-arama-input").value = "";
  $("mesaj-arama-sayac").textContent = "";
  mesajAlaniCiz(mesajlarCache);
}
$("mesaj-arama-kapat").addEventListener("click", aramaKapat);

$("mesaj-arama-input").addEventListener("input", (e) => {
  aramaSorgu = e.target.value.trim();
  aramaAktifIndeks = aramaSorgu ? 0 : -1;
  mesajAlaniCiz(mesajlarCache);
});

$("mesaj-arama-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    if (e.shiftKey) aramaOnceki(); else aramaSonraki();
  } else if (e.key === "Escape") {
    aramaKapat();
  }
});

$("mesaj-arama-yukari").addEventListener("click", aramaOnceki);
$("mesaj-arama-asagi").addEventListener("click", aramaSonraki);

function aramaSonraki() {
  if (!aramaEslesenMesajIdler.length) return;
  aramaAktifIndeks = (aramaAktifIndeks + 1) % aramaEslesenMesajIdler.length;
  aramaOdaklanGuncelle();
}
function aramaOnceki() {
  if (!aramaEslesenMesajIdler.length) return;
  aramaAktifIndeks = (aramaAktifIndeks - 1 + aramaEslesenMesajIdler.length) % aramaEslesenMesajIdler.length;
  aramaOdaklanGuncelle();
}

function aramaOdaklanGuncelle() {
  $("mesaj-alani").querySelectorAll(".balon.arama-odakli").forEach((b) => b.classList.remove("arama-odakli"));
  $("mesaj-alani").querySelectorAll(".arama-vurgu-aktif").forEach((m) => m.classList.remove("arama-vurgu-aktif"));

  const mesajId = aramaEslesenMesajIdler[aramaAktifIndeks];
  $("mesaj-arama-sayac").textContent = mesajId ? `${aramaAktifIndeks + 1} / ${aramaEslesenMesajIdler.length}` : "0 / 0";
  if (!mesajId) return;

  const balon = $("mesaj-alani").querySelector(`.balon[data-mesaj-id="${mesajId}"]`);
  if (!balon) return;
  balon.classList.add("arama-odakli");
  const ilkVurgu = balon.querySelector(".arama-vurgu");
  if (ilkVurgu) ilkVurgu.classList.add("arama-vurgu-aktif");
  balon.scrollIntoView({ behavior: "smooth", block: "center" });
}

function mesajlariDinle(sohbetId) {
  if (mesajAbonelik) mesajAbonelik();
  ilkMesajYuklemesi = true;
  const q = query(
    collection(db, "sohbetler", sohbetId, "mesajlar"),
    orderBy("zaman", "asc"),
    limit(500)
  );
  mesajAbonelik = onSnapshot(q, (snap) => {
    // Cache'i her zaman güncel tut (diğer fonksiyonlar mesajlarCache'i okuyor).
    let ham = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Kaybolan mesajlar: süresi geçmişleri hem ekrandan gizle hem de sil.
    // (Herhangi bir üye açtığında silinir — böylece TTL sunucu-cron gerektirmez.)
    const simdi = Date.now();
    const suresiGecmis = ham.filter((m) => m.sonKullanmaMs && m.sonKullanmaMs <= simdi);
    if (suresiGecmis.length) {
      suresiGecmis.forEach((m) => {
        deleteDoc(doc(db, "sohbetler", sohbetId, "mesajlar", m.id)).catch(() => {});
      });
      ham = ham.filter((m) => !(m.sonKullanmaMs && m.sonKullanmaMs <= simdi));
    }

    // "Sohbeti sil" ile bu sohbeti kendi listemizden temizlediysek, o silme
    // anından ÖNCEKİ mesajları kendi ekranımızda göstermiyoruz (karşı tarafta
    // ve Firestore'da hâlâ duruyorlar — sadece bizim görünümümüzden gizleniyor).
    const kendiSilmeZamani = (tumUyeler[suankiKullanici?.uid]?.silinenSohbetler || {})[sohbetId];
    if (kendiSilmeZamani) {
      ham = ham.filter((m) => (m.zaman?.toMillis?.() || 0) > kendiSilmeZamani);
    }

    mesajlarCache = ham;

    // Arama modundayken ya da ilk yüklemede tam çizim yapıyoruz (gün ayraçları
    // ve arama vurgusu için basit ve doğru yol). Sonraki güncellemelerde ise
    // yalnızca DEĞİŞEN mesajları hedefli olarak DOM'a yansıtıyoruz — böylece
    // her tepki/görüldü/yeni mesajda 500 balonun yeniden çizilmesi (titreme,
    // çalan sesin kesilmesi, gecikme) ortadan kalkar.
    if (ilkMesajYuklemesi || aramaAktif) {
      ilkMesajYuklemesi = false;
      mesajAlaniCiz(mesajlarCache);
    } else {
      mesajlariTazele(snap);
    }

    // Görüldü işaretlemesi artık render'dan tamamen ayrı ve TOPLU yapılıyor
    // (tek writeBatch), böylece "her render'da N ayrı yazma -> yeni snapshot ->
    // tekrar render" fırtınası oluşmuyor.
    mesajGorulduIsaretle(mesajlarCache);
  });
}

// Tek bir mesaj için tam DOM elemanı üretir (satır veya doğum günü kartı).
// Görüldü işaretlemesi YAPMAZ (o iş mesajGorulduIsaretle'de toplu yapılır).
// Döndürülen elemanda data-mesaj-id bulunur; incremental güncellemede yerini
// bulmak için kullanılır.
function mesajElemaniOlustur(m) {
  const giden = m.gonderenUid === suankiKullanici.uid;

  if (m.tip === "dogumgunu") {
    const kutlama = document.createElement("div");
    kutlama.className = "dogumgunu-mesaji";
    kutlama.dataset.mesajId = m.id;
    kutlama.innerHTML = `🎂 ${kacir(m.metin || (m.dogumGunuAd + "'in doğum günü!"))}`;
    return kutlama;
  }

  const satir = document.createElement("div");
  satir.className = "mesaj-satiri " + (giden ? "giden" : "gelen");
  satir.dataset.mesajId = m.id;

  const balon = document.createElement("div");
  balon.className = "balon " + (giden ? "giden" : "gelen") + ((m.bahsedilenler || []).includes(suankiKullanici.uid) ? " balon-bahsetme" : "");
  balon.dataset.mesajId = m.id;
  balon.dataset.tip = m.tip || "metin";

  let icerik = "";
  if (m.iletildi && !m.silindi) {
    icerik += `<span class="iletildi-etiket">📤 İletildi</span>`;
  }
  if (aktifSohbetTipi === "grup" && !giden) {
    icerik += `<span class="gonderen-adi">${kacir(tumUyeler[m.gonderenUid]?.ad || "Üye")}</span>`;
  }
  if (m.yanitlanan && !m.silindi) {
    icerik += `<div class="alintilanan-onizleme" data-hedef-id="${kacir(m.yanitlanan.id)}">
      <span class="alintilanan-ad">${kacir(m.yanitlanan.gonderenAd || "Üye")}</span>
      <span class="alintilanan-ozet">${kacir(m.yanitlanan.ozet || "")}</span>
    </div>`;
  }
  if (m.statuYaniti && !m.silindi) {
    icerik += `<div class="statu-yaniti-onizleme">
      <span class="statu-yaniti-etiket">📖 Statüsüne yanıt</span>
      ${m.statuYaniti.medyaUrl ? `<img src="${m.statuYaniti.medyaUrl}" alt="statü" />` : ""}
      ${m.statuYaniti.ozet ? `<span class="statu-yaniti-ozet">${kacir(m.statuYaniti.ozet)}</span>` : ""}
    </div>`;
  }
  if (m.silindi) {
    icerik += `<span class="mesaj-silindi">Bu mesaj silindi</span>`;
  } else if (m.tip === "ses") {
    const dk = Math.floor((m.sureSn || 0) / 60);
    const sn = (m.sureSn || 0) % 60;
    icerik += `<div class="ses-mesaji">
      <audio controls preload="none" src="${m.dosyaUrl}"></audio>
      <span style="font-size:11.5px;color:var(--metin-soluk);">${dk}:${String(sn).padStart(2, "0")}</span>
    </div>`;
  } else if (m.tip === "gorsel") {
    icerik += `<img class="eklenti-gorsel" src="${m.dosyaUrl}" alt="görsel" />`;
    if (m.metin) icerik += `<div style="margin-top:6px;">${aramaMetniVurgula(m.metin)}</div>`;
  } else if (m.tip === "dosya") {
    icerik += `<a class="dosya-eklenti" href="${m.dosyaUrl}" target="_blank" rel="noopener">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
      <span class="dosya-ad">${kacir(m.dosyaAd || "Dosya")}</span>
    </a>`;
  } else if (m.tip === "konum") {
    const haritaSrc = staticHaritaUrl(m.lat, m.lng, 240, 130);
    const haritaLink = osmHaritaLinki(m.lat, m.lng);
    icerik += `<a class="konum-karti" href="${haritaLink}" target="_blank" rel="noopener">
      <img src="${haritaSrc}" alt="konum" />
      <span class="konum-etiket">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
        Konum — haritada aç
      </span>
    </a>`;
    if (m.metin) icerik += `<div style="margin-top:6px;">${aramaMetniVurgula(m.metin)}</div>`;
  } else {
    icerik += aramaMetniVurgula(m.metin || "");
  }
  icerik += `<div class="zaman-etiketi">${zamanFormatla(m.zaman)}${(m.duzenlendi && !m.silindi) ? '<span class="mesaj-duzenlendi-etiket">düzenlendi</span>' : ""}${giden ? tikHTML(m) : ""}</div>`;

  balon.innerHTML = icerik;

  const balonGrup = document.createElement("div");
  balonGrup.className = "balon-grup " + (giden ? "giden" : "gelen");
  balonGrup.appendChild(balon);

  if (!m.silindi) {
    const tepkiBar = tepkiBarOlustur(m, giden);
    if (tepkiBar) balonGrup.appendChild(tepkiBar);
  }

  satir.appendChild(balonGrup);
  return satir;
}

// Bir mesajdan önce gerekiyorsa gün ayracı üretir (yoksa null). oncekiGun
// referansı çağıran tarafça tutulur.
function gunAyraciOlustur(gunEtiketMetni) {
  const ayrac = document.createElement("div");
  ayrac.className = "gun-ayraci";
  ayrac.dataset.gun = gunEtiketMetni;
  ayrac.textContent = gunEtiketMetni;
  return ayrac;
}

// TOPLU görüldü işaretlemesi: bana gelen ve henüz görülmemiş mesajları tek bir
// writeBatch ile işaretler. Render'dan bağımsızdır; birden çok görülmemiş mesaj
// olsa bile tek yazma turu yapılır (eski "her mesaj için ayrı updateDoc" ->
// snapshot fırtınası sorununu ortadan kaldırır).
async function mesajGorulduIsaretle(mesajlar) {
  if (!aktifSohbetId) return;
  const isaretlenecek = mesajlar.filter(
    (m) => m.gonderenUid !== suankiKullanici.uid && m.zaman && !(m.gorenler || []).includes(suankiKullanici.uid)
  );
  if (!isaretlenecek.length) return;
  const sohbetId = aktifSohbetId; // asenkron sırasında değişebilir; sabitle
  try {
    // Firestore tek batch'te en çok 500 işlem kabul eder; parçalara böl.
    for (let i = 0; i < isaretlenecek.length; i += 400) {
      const dilim = isaretlenecek.slice(i, i + 400);
      const batch = writeBatch(db);
      dilim.forEach((m) => {
        batch.update(doc(db, "sohbetler", sohbetId, "mesajlar", m.id), {
          gorenler: arrayUnion(suankiKullanici.uid)
        });
      });
      await batch.commit();
    }
  } catch { /* izin/ağ hatası — sessizce geç, bir sonraki snapshot'ta tekrar denenir */ }
}

// docChanges bazlı hedefli güncelleme: yalnızca eklenen/değişen/silinen
// mesajları DOM'a yansıtır. Tüm alanı yeniden çizmez.
function mesajlariTazele(snap) {
  const alan = $("mesaj-alani");
  const altaYakinKaydirma = alan.scrollHeight - alan.scrollTop - alan.clientHeight < 80;

  snap.docChanges().forEach((c) => {
    const m = { id: c.doc.id, ...c.doc.data() };

    if (c.type === "removed") {
      alan.querySelector(`[data-mesaj-id="${cssKacir(m.id)}"]`)?.remove();
      mesajGorunumOnbellek.delete(m.id);
      return;
    }

    if (c.type === "modified") {
      const eski = alan.querySelector(`[data-mesaj-id="${cssKacir(m.id)}"]`);
      if (eski) {
        // Optimizasyon: yalnızca "gorenler" (görüldü tiki) değiştiyse tüm balonu
        // yeniden kurmak yerine sadece tik'i yerinde güncelle. Böylece o mesajda
        // çalan ses/oynayan video kesilmez ve gereksiz DOM işi yapılmaz.
        const oncekiM = mesajGorunumOnbellek.get(m.id);
        const sadeceGorulduDegisti = oncekiM && sadeceGorenlerDegisti(oncekiM, m);
        if (sadeceGorulduDegisti && m.gonderenUid === suankiKullanici.uid) {
          const tikKapsayici = eski.querySelector(".zaman-etiketi .mesaj-tik");
          if (tikKapsayici) {
            const gorendu = aktifSohbetTipi === "birebir"
              ? (m.gorenler || []).includes(aktifSohbetKarsi)
              : (m.gorenler || []).length > 0;
            tikKapsayici.classList.toggle("gorundu", gorendu);
            tikKapsayici.classList.toggle("gorulmedi", !gorendu);
            mesajGorunumOnbellek.set(m.id, m);
            return;
          }
        }
        eski.replaceWith(mesajElemaniOlustur(m));
        mesajGorunumOnbellek.set(m.id, m);
        return;
      }
      // Elemanı bulamadıysak (nadiren) ekleme olarak ele al.
    }

    // added (veya modified'te eleman bulunamadıysa): doğru sıraya ekle.
    mesajElemaniniSiraliEkle(alan, m);
  });

  if (altaYakinKaydirma) alan.scrollTop = alan.scrollHeight;
}

// Bir mesaj elemanını zamana göre doğru konuma ekler ve gerekiyorsa gün
// ayracını yönetir. Cache zaten sıralı (orderBy zaman asc) olduğundan, bu
// mesajdan hemen sonra gelen mesajın elemanını referans alarak insertBefore
// yapıyoruz; sondaysa append.
function mesajElemaniniSiraliEkle(alan, m) {
  const idx = mesajlarCache.findIndex((x) => x.id === m.id);
  const yeni = mesajElemaniOlustur(m);

  // Gün ayracı: bu mesaj, kendi gününün ilk mesajıysa önüne ayraç gerekir.
  const buGun = m.zaman ? gunEtiketi(m.zaman) : null;
  const oncekiMesaj = idx > 0 ? mesajlarCache[idx - 1] : null;
  const oncekiGun = oncekiMesaj?.zaman ? gunEtiketi(oncekiMesaj.zaman) : null;
  const ayracGerekli = buGun && buGun !== oncekiGun;

  // Sonraki mesajın DOM elemanını bul (insertBefore referansı).
  let referans = null;
  for (let i = idx + 1; i < mesajlarCache.length; i++) {
    const el = alan.querySelector(`[data-mesaj-id="${cssKacir(mesajlarCache[i].id)}"]`);
    if (el) {
      // Eğer o elemanın hemen öncesinde onun gün ayracı varsa, referansı ayraca al.
      const onceki = el.previousElementSibling;
      referans = (onceki && onceki.classList.contains("gun-ayraci")) ? onceki : el;
      break;
    }
  }

  if (ayracGerekli) {
    const ayrac = gunAyraciOlustur(buGun);
    if (referans) alan.insertBefore(ayrac, referans);
    else alan.appendChild(ayrac);
  }
  if (referans) alan.insertBefore(yeni, referans);
  else alan.appendChild(yeni);
  mesajGorunumOnbellek.set(m.id, m);
}

// Mesajların son işlenmiş halini tutar (id -> mesaj). "modified" geldiğinde
// yalnızca gorenler mi değişti anlamak için önceki halle karşılaştırılır.
const mesajGorunumOnbellek = new Map();

// İki mesaj sürümü arasında SADECE "gorenler" alanının değişip değişmediğini
// söyler. gorenler dışında görsel bir alan değiştiyse false döner (tam yeniden
// çizim gerekir). Basit alan karşılaştırması yeterli — mesaj içerikleri
// düzenleme/silme dışında değişmez.
function sadeceGorenlerDegisti(a, b) {
  const ilgili = ["metin", "silindi", "duzenlendi", "tepkiler", "iletildi", "dosyaUrl", "tip"];
  for (const k of ilgili) {
    if (JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)) return false;
  }
  return true;
}

// querySelector içinde güvenli kullanım için id'deki özel karakterleri kaçır.
function cssKacir(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/["\\\]]/g, "\\$&");
}

function mesajAlaniCiz(mesajlar) {
  const alan = $("mesaj-alani");
  const altaYakinKaydirma = alan.scrollHeight - alan.scrollTop - alan.clientHeight < 80;
  alan.innerHTML = "";

  const eslesenler = [];
  const sorguKucuk = aramaSorgu.toLowerCase();

  // Tam çizimde görünüm önbelleğini bu sohbetin güncel mesajlarına göre sıfırla.
  mesajGorunumOnbellek.clear();

  let sonGun = null;
  mesajlar.forEach((m) => {
    const gun = m.zaman ? gunEtiketi(m.zaman) : null;
    if (gun && gun !== sonGun) {
      alan.appendChild(gunAyraciOlustur(gun));
      sonGun = gun;
    }

    if (sorguKucuk && !m.silindi && m.metin && m.metin.toLowerCase().includes(sorguKucuk)) {
      eslesenler.push(m.id);
    }

    alan.appendChild(mesajElemaniOlustur(m));
    mesajGorunumOnbellek.set(m.id, m);
  });

  if (aramaAktif) {
    aramaEslesenMesajIdler = eslesenler;
    if (aramaSorgu) {
      if (aramaAktifIndeks < 0 || aramaAktifIndeks >= eslesenler.length) aramaAktifIndeks = eslesenler.length ? 0 : -1;
      aramaOdaklanGuncelle();
    } else {
      aramaAktifIndeks = -1;
      $("mesaj-arama-sayac").textContent = "";
    }
  }

  if (altaYakinKaydirma && !aramaAktif) alan.scrollTop = alan.scrollHeight;
}

function tikHTML(m) {
  const gorenler = m.gorenler || [];
  let gorundu = false;
  if (aktifSohbetTipi === "birebir") {
    gorundu = gorenler.includes(aktifSohbetKarsi);
  } else {
    gorundu = gorenler.length > 0;
  }
  const sinif = gorundu ? "gorundu" : "gorulmedi";
  return `<span class="mesaj-tik ${sinif}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M2 12l5 5L20 5"/><path d="M9 12l5 5L27 5" transform="translate(-3)"/></svg>
  </span>`;
}

// ---------- Mesaj tepkileri (emoji ile tepki verme) ----------
const TEPKI_EMOJILER = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

function tepkiBarOlustur(m, giden) {
  const tepkiler = m.tepkiler || {};
  const uidler = Object.keys(tepkiler);
  if (!uidler.length) return null;

  // emoji -> uid listesi
  const gruplar = {};
  uidler.forEach((uid) => {
    const emoji = tepkiler[uid];
    if (!emoji) return;
    (gruplar[emoji] = gruplar[emoji] || []).push(uid);
  });
  if (!Object.keys(gruplar).length) return null;

  const bar = document.createElement("div");
  bar.className = "mesaj-tepkiler " + (giden ? "giden" : "gelen");

  Object.entries(gruplar).forEach(([emoji, uidListesi]) => {
    const benimMi = uidListesi.includes(suankiKullanici.uid);
    const pil = document.createElement("button");
    pil.type = "button";
    pil.className = "tepki-pil" + (benimMi ? " benim" : "");
    pil.title = uidListesi.map((uid) => tumUyeler[uid]?.ad || "Üye").join(", ");
    pil.innerHTML = `${emoji} <span>${uidListesi.length}</span>`;
    pil.addEventListener("click", (e) => {
      e.stopPropagation();
      tepkiVer(m.id, emoji);
    });
    bar.appendChild(pil);
  });

  return bar;
}

async function tepkiVer(mesajId, emoji) {
  if (!aktifSohbetId || !suankiKullanici) return;
  const mesaj = mesajlarCache.find((x) => x.id === mesajId);
  const oncekiTepki = mesaj?.tepkiler?.[suankiKullanici.uid];
  const ref = doc(db, "sohbetler", aktifSohbetId, "mesajlar", mesajId);
  try {
    if (oncekiTepki === emoji) {
      // Aynı emojiye tekrar tıklanırsa tepkiyi kaldır
      await updateDoc(ref, { [`tepkiler.${suankiKullanici.uid}`]: deleteField() });
    } else {
      await updateDoc(ref, { [`tepkiler.${suankiKullanici.uid}`]: emoji });
    }
  } catch (err) {
    console.error("Tepki kaydedilemedi:", err);
  }
}

function tepkiPickerKapat() {
  const mevcut = document.getElementById("tepki-picker");
  if (mevcut) mevcut.remove();
  document.removeEventListener("click", tepkiPickerDisaTiklamaKapat, true);
}
function tepkiPickerDisaTiklamaKapat(e) {
  const picker = document.getElementById("tepki-picker");
  if (picker && !picker.contains(e.target)) tepkiPickerKapat();
}

function tepkiPickerAc(mesajId, x, y) {
  tepkiPickerKapat();
  const m = mesajlarCache.find((mm) => mm.id === mesajId);
  if (!m || m.silindi) return;

  const picker = document.createElement("div");
  picker.id = "tepki-picker";
  picker.className = "tepki-picker";

  TEPKI_EMOJILER.forEach((emoji) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = emoji;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      tepkiVer(mesajId, emoji);
      tepkiPickerKapat();
    });
    picker.appendChild(btn);
  });

  document.body.appendChild(picker);

  // Görünür alanın dışına taşmayı engelle
  const genislik = picker.offsetWidth, yukseklik = picker.offsetHeight;
  let solX = x - genislik / 2;
  let ustY = y - yukseklik - 12;
  solX = Math.max(8, Math.min(solX, window.innerWidth - genislik - 8));
  if (ustY < 8) ustY = y + 16;
  picker.style.left = solX + "px";
  picker.style.top = ustY + "px";

  setTimeout(() => document.addEventListener("click", tepkiPickerDisaTiklamaKapat, true), 0);
}

// Uzun basma (mobil) / fare ile basılı tutma (masaüstü) ile tepki seçiciyi aç
let tepkiUzunBasmaZamanlayici = null;
let tepkiUzunBasmaBaslangic = null;
$("mesaj-alani").addEventListener("pointerdown", (e) => {
  const balon = e.target.closest(".balon");
  if (!balon || balon.dataset.tip === "dogumgunu") return;
  tepkiUzunBasmaBaslangic = { x: e.clientX, y: e.clientY };
  const mesajId = balon.dataset.mesajId;
  tepkiUzunBasmaZamanlayici = setTimeout(() => {
    tepkiUzunBasmaZamanlayici = null;
    tepkiPickerAc(mesajId, e.clientX, e.clientY);
  }, 420);
});
["pointerup", "pointerleave", "pointercancel"].forEach((olay) => {
  $("mesaj-alani").addEventListener(olay, () => {
    if (tepkiUzunBasmaZamanlayici) { clearTimeout(tepkiUzunBasmaZamanlayici); tepkiUzunBasmaZamanlayici = null; }
  });
});
$("mesaj-alani").addEventListener("pointermove", (e) => {
  if (!tepkiUzunBasmaZamanlayici || !tepkiUzunBasmaBaslangic) return;
  const dx = e.clientX - tepkiUzunBasmaBaslangic.x, dy = e.clientY - tepkiUzunBasmaBaslangic.y;
  if (Math.sqrt(dx * dx + dy * dy) > 10) { clearTimeout(tepkiUzunBasmaZamanlayici); tepkiUzunBasmaZamanlayici = null; }
});


let secilenMesajId = null;
$("mesaj-alani").addEventListener("click", (e) => {
  if (e.target.classList.contains("eklenti-gorsel")) {
    window.open(e.target.src, "_blank");
    return;
  }
  if (e.target.closest(".alintilanan-onizleme")) return; // alıntı önizlemesi ayrı işleniyor (mesaja git)
  if (e.target.closest(".tepki-pil")) return; // tepki rozetleri ayrı işleniyor
  if (e.target.closest("a")) return; // dosya/konum linklerine tıklamayı engelleme
  if (e.target.closest("audio")) return; // sesli mesaj oynatıcısına tıklamayı engelleme

  const balon = e.target.closest(".balon");
  if (!balon) return;
  const m = mesajlarCache.find((x) => x.id === balon.dataset.mesajId);
  if (!m || m.silindi || m.tip === "dogumgunu") return;

  const kendiMesajiMi = m.gonderenUid === suankiKullanici.uid;
  const mesajZamaniMs = m.zaman ? (m.zaman.toDate ? m.zaman.toDate().getTime() : new Date(m.zaman).getTime()) : 0;
  const duzenlemeSuresiDoldu = !mesajZamaniMs || (Date.now() - mesajZamaniMs) > MESAJ_DUZENLEME_SURESI_MS;
  secilenMesajId = m.id;
  $("mesaj-duzenle-btn").style.display = (kendiMesajiMi && m.tip === "metin" && !duzenlemeSuresiDoldu) ? "block" : "none";
  $("mesaj-sil-btn").style.display = kendiMesajiMi ? "block" : "none";

  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  const sabitliMi = s?.sabitlenmisMesaj?.id === m.id;
  $("mesaj-sabitle-btn").textContent = sabitliMi ? "📌 Sabitlemeyi kaldır" : "📌 Sabitle";

  goster($("modal-mesaj-aksiyon"));
});

$("mesaj-yanitla-btn").addEventListener("click", () => {
  const m = mesajlarCache.find((x) => x.id === secilenMesajId);
  if (!m) return;
  sakla($("modal-mesaj-aksiyon"));
  yanitlaBaslat(m.id);
});

// ---------- Sabitlenmiş mesaj (sohbet başına tek mesaj) ----------
$("mesaj-sabitle-btn").addEventListener("click", async () => {
  const m = mesajlarCache.find((x) => x.id === secilenMesajId);
  if (!m || !aktifSohbetId) return;
  sakla($("modal-mesaj-aksiyon"));
  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  const sabitliMi = s?.sabitlenmisMesaj?.id === m.id;
  try {
    if (sabitliMi) {
      await updateDoc(doc(db, "sohbetler", aktifSohbetId), { sabitlenmisMesaj: deleteField() });
    } else {
      await updateDoc(doc(db, "sohbetler", aktifSohbetId), {
        sabitlenmisMesaj: {
          id: m.id,
          ozet: yanitOzeti(m),
          gonderenAd: m.gonderenUid === suankiKullanici.uid ? "Sen" : (tumUyeler[m.gonderenUid]?.ad || "Üye")
        }
      });
    }
  } catch (err) {
    alert("Sabitleme işlemi başarısız: " + err.message);
  }
});

function sabitBannerGuncelle() {
  const banner = $("sabit-banner");
  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  const sabit = s?.sabitlenmisMesaj;
  if (!aktifSohbetId || !sabit) { sakla(banner); return; }
  $("sabit-banner-ozet").textContent = `${sabit.gonderenAd}: ${sabit.ozet}`;
  goster(banner);
}

$("sabit-banner-icerik").addEventListener("click", () => {
  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  if (s?.sabitlenmisMesaj?.id) alintilananaGit(s.sabitlenmisMesaj.id);
});

$("sabit-kaldir-btn").addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!aktifSohbetId) return;
  try {
    await updateDoc(doc(db, "sohbetler", aktifSohbetId), { sabitlenmisMesaj: deleteField() });
  } catch (err) {
    alert("Sabitleme kaldırılamadı: " + err.message);
  }
});

// ---------- Mesaj iletme (başka bir sohbete/gruba aktarma) ----------
let iletilecekMesajId = null;

function sohbetAdiVeAvatari(s) {
  const grup = s.tip === "grup";
  if (grup) {
    const ad = s.ad || "Grup";
    return { ad, avatar: s.grupFotoUrl ? `<img src="${s.grupFotoUrl}" alt="" />` : harfBas(ad), grup: true };
  }
  const karsiUid = s.uyeler.find((u) => u !== suankiKullanici.uid);
  return { ad: tumUyeler[karsiUid]?.ad || "Üye", avatar: avatarIcerik(tumUyeler[karsiUid]), grup: false };
}

$("mesaj-ilet-btn").addEventListener("click", () => {
  const m = mesajlarCache.find((x) => x.id === secilenMesajId);
  if (!m) return;
  sakla($("modal-mesaj-aksiyon"));
  iletilecekMesajId = m.id;

  const liste = $("ilet-sohbet-secim-listesi");
  liste.innerHTML = "";
  if (!sohbetlerCache.length) {
    liste.innerHTML = `<div class="bos-liste">İletilecek başka bir sohbet yok.</div>`;
  } else {
    sohbetlerCache.forEach((s) => {
      const { ad, avatar, grup } = sohbetAdiVeAvatari(s);
      const satir = document.createElement("label");
      satir.className = "uye-secim-ogesi";
      satir.innerHTML = `<input type="checkbox" value="${s.id}" />
        <div class="avatar ${grup ? "grup" : ""}" style="width:32px;height:32px;font-size:13px;">${avatar}</div>
        ${kacir(ad)}`;
      liste.appendChild(satir);
    });
  }
  goster($("modal-mesaj-ilet"));
});

$("mesaj-ilet-gonder-btn").addEventListener("click", async () => {
  const m = mesajlarCache.find((x) => x.id === iletilecekMesajId);
  const hedefler = [...document.querySelectorAll('#ilet-sohbet-secim-listesi input:checked')].map((i) => i.value);
  if (!m) { sakla($("modal-mesaj-ilet")); return; }
  if (!hedefler.length) { alert("İletmek için en az bir sohbet seç."); return; }

  sakla($("modal-mesaj-ilet"));
  try {
    for (const hedefSohbetId of hedefler) {
      const kopya = {
        gonderenUid: suankiKullanici.uid,
        tip: m.tip || "metin",
        iletildi: true,
        zaman: serverTimestamp()
      };
      if (m.metin) kopya.metin = m.metin;
      if (m.dosyaUrl) kopya.dosyaUrl = m.dosyaUrl;
      if (m.dosyaAd) kopya.dosyaAd = m.dosyaAd;
      if (m.sureSn) kopya.sureSn = m.sureSn;
      if (m.lat != null) kopya.lat = m.lat;
      if (m.lng != null) kopya.lng = m.lng;

      await addDoc(collection(db, "sohbetler", hedefSohbetId, "mesajlar"), kopya);
      await sohbetSonMesajGuncelle(yanitOzeti(kopya), hedefSohbetId);
    }
  } catch (err) {
    alert("Mesaj iletilemedi: " + err.message);
  }
});

$("mesaj-duzenle-btn").addEventListener("click", () => {
  const m = mesajlarCache.find((x) => x.id === secilenMesajId);
  if (!m || m.gonderenUid !== suankiKullanici.uid) return;
  const mesajZamaniMs = m.zaman ? (m.zaman.toDate ? m.zaman.toDate().getTime() : new Date(m.zaman).getTime()) : 0;
  if (!mesajZamaniMs || (Date.now() - mesajZamaniMs) > MESAJ_DUZENLEME_SURESI_MS) {
    sakla($("modal-mesaj-aksiyon"));
    alert("Bu mesaj gönderileli 15 dakikadan uzun süre geçtiği için artık düzenlenemez.");
    return;
  }
  sakla($("modal-mesaj-aksiyon"));
  yanitlaIptal();
  duzenlenenMesajId = m.id;
  girisKutu.value = m.metin || "";
  girisKutu.focus();
  girisKutu.style.height = "auto";
  girisKutu.style.height = Math.min(girisKutu.scrollHeight, 110) + "px";
  goster($("duzenleme-bandi"));
});

$("duzenleme-iptal-btn").addEventListener("click", () => {
  duzenlenenMesajId = null;
  girisKutu.value = "";
  sakla($("duzenleme-bandi"));
});

// ---------- Mesajı yanıtlama (alıntılayarak cevap verme) ----------
let yanitlananMesajId = null;

function yanitOzeti(m) {
  if (m.silindi) return "Silinen mesaj";
  if (m.tip === "gorsel") return "📷 Görsel" + (m.metin ? ": " + m.metin : "");
  if (m.tip === "dosya") return "📎 " + (m.dosyaAd || "Dosya");
  if (m.tip === "konum") return "📍 Konum";
  if (m.tip === "ses") return "🎤 Sesli mesaj";
  if (m.tip === "dogumgunu") return "🎂 Doğum günü kutlaması";
  return (m.metin || "").slice(0, 160);
}

function yanitlaBaslat(mesajId) {
  const m = mesajlarCache.find((x) => x.id === mesajId);
  if (!m) return;
  // Düzenleme modundaysak önce onu kapat — ikisi aynı anda olmasın
  if (duzenlenenMesajId) {
    duzenlenenMesajId = null;
    girisKutu.value = "";
    sakla($("duzenleme-bandi"));
  }
  yanitlananMesajId = mesajId;
  const gonderenMi = m.gonderenUid === suankiKullanici.uid;
  $("yanitla-bandi-ad").textContent = gonderenMi ? "Sen" : (tumUyeler[m.gonderenUid]?.ad || "Üye");
  $("yanitla-bandi-ozet").textContent = yanitOzeti(m);
  goster($("yanitla-bandi"));
  girisKutu.focus();
}

function yanitlaIptal() {
  yanitlananMesajId = null;
  sakla($("yanitla-bandi"));
}
$("yanitla-iptal-btn").addEventListener("click", yanitlaIptal);

// Gönderilecek mesaja eklenecek alıntı verisini hazırlar (varsa)
function yanitlananAlaniHazirla() {
  if (!yanitlananMesajId) return {};
  const m = mesajlarCache.find((x) => x.id === yanitlananMesajId);
  if (!m) return {};
  return {
    yanitlanan: {
      id: m.id,
      gonderenUid: m.gonderenUid,
      gonderenAd: tumUyeler[m.gonderenUid]?.ad || "Üye",
      ozet: yanitOzeti(m)
    }
  };
}

// Bir mesajdaki alıntı önizlemesine tıklayınca orijinal mesaja kaydır ve kısaca vurgula
function alintilananaGit(mesajId) {
  const hedef = $("mesaj-alani").querySelector(`.balon[data-mesaj-id="${mesajId}"]`);
  if (!hedef) return;
  hedef.scrollIntoView({ behavior: "smooth", block: "center" });
  hedef.classList.add("vurgulu");
  setTimeout(() => hedef.classList.remove("vurgulu"), 1400);
}
$("mesaj-alani").addEventListener("click", (e) => {
  const onizleme = e.target.closest(".alintilanan-onizleme");
  if (onizleme) alintilananaGit(onizleme.dataset.hedefId);
});

$("mesaj-sil-btn").addEventListener("click", async () => {
  const mesajId = secilenMesajId;
  const m = mesajlarCache.find((x) => x.id === mesajId);
  sakla($("modal-mesaj-aksiyon"));
  if (!mesajId || !aktifSohbetId || !m || m.gonderenUid !== suankiKullanici.uid) return;
  if (!confirm("Bu mesajı silmek istediğine emin misin?")) return;
  try {
    await updateDoc(doc(db, "sohbetler", aktifSohbetId, "mesajlar", mesajId), {
      silindi: true
    });
    if (duzenlenenMesajId === mesajId) {
      duzenlenenMesajId = null;
      girisKutu.value = "";
      sakla($("duzenleme-bandi"));
    }
  } catch (err) {
    alert("Mesaj silinemedi: " + err.message);
  }
});

// ---------- Mesaj gönderme ----------
const girisKutu = $("mesaj-girisi");

// ---------- Hız sınırlama / spam koruması (istemci tarafı) ----------
// Tam sunucu taraflı hız sınırlama (App Check + Cloud Functions vb.) ücretsiz/
// sunucusuz kurulumun kapsamı dışında; bu nedenle burada: (1) art arda çift
// tıklama/Enter'a karşı kısa bir bekleme, (2) kısa sürede çok fazla mesaja karşı
// kayan pencereli bir sınır, (3) aşırı uzun mesaj metnine karşı bir karakter
// sınırı uygulanıyor. Bu, kazara/ısrarlı spam'e karşı pratik bir koruma sağlar.
const MESAJ_MAKS_KARAKTER = 4000;
const MESAJ_DUZENLEME_SURESI_MS = 15 * 60 * 1000; // 15 dakika
const GONDERIM_MIN_ARALIK_MS = 350;     // aynı butona çok hızlı çift tıklamayı engelle
const GONDERIM_PENCERE_MS = 10000;      // 10 saniyelik pencere
const GONDERIM_PENCERE_MAKS = 12;       // bu pencerede en fazla 12 gönderim
let sonGonderimMs = 0;
let gonderimZamanlari = [];
let spamUyariZamanlayici = null;

function gonderimIzniVarMi() {
  const simdi = Date.now();
  if (simdi - sonGonderimMs < GONDERIM_MIN_ARALIK_MS) return false; // sessizce engelle (çift tık)
  gonderimZamanlari = gonderimZamanlari.filter((t) => simdi - t < GONDERIM_PENCERE_MS);
  if (gonderimZamanlari.length >= GONDERIM_PENCERE_MAKS) {
    spamUyarisiGoster();
    return false;
  }
  return true;
}
function gonderimKaydet() {
  const simdi = Date.now();
  sonGonderimMs = simdi;
  gonderimZamanlari.push(simdi);
}
function spamUyarisiGoster() {
  const el = $("spam-uyari");
  goster(el);
  clearTimeout(spamUyariZamanlayici);
  spamUyariZamanlayici = setTimeout(() => sakla(el), 4000);
}
girisKutu.addEventListener("input", () => {
  if (girisKutu.value.length > MESAJ_MAKS_KARAKTER) {
    girisKutu.value = girisKutu.value.slice(0, MESAJ_MAKS_KARAKTER);
  }
  girisKutu.style.height = "auto";
  girisKutu.style.height = Math.min(girisKutu.scrollHeight, 110) + "px";
  bildirYaziyorum();
  bahsetmeKontrolEt();
});
girisKutu.addEventListener("blur", () => setTimeout(bahsetmeListesiKapat, 120));
girisKutu.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    mesajGonder();
  }
});
$("gonder-btn").addEventListener("click", mesajGonder);

// ---------- @İsim ile bahsetme (sadece grup sohbetlerinde) ----------
let bahsetmeBaslangicIndeks = -1;

function bahsetmeKontrolEt() {
  if (aktifSohbetTipi !== "grup") { bahsetmeListesiKapat(); return; }
  const deger = girisKutu.value;
  const imlec = girisKutu.selectionStart;
  const metinOncesi = deger.slice(0, imlec);
  const eslesme = metinOncesi.match(/@([a-zA-ZçÇğĞıİöÖşŞüÜ]*)$/);
  if (!eslesme) { bahsetmeListesiKapat(); return; }

  const sorgu = eslesme[1].toLowerCase();
  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  if (!s) { bahsetmeListesiKapat(); return; }

  const adaylar = (s.uyeler || [])
    .filter((uid) => uid !== suankiKullanici.uid)
    .map((uid) => ({ uid, ad: tumUyeler[uid]?.ad || "Üye" }))
    .filter((u) => u.ad.toLowerCase().includes(sorgu));

  if (!adaylar.length) { bahsetmeListesiKapat(); return; }
  bahsetmeBaslangicIndeks = eslesme.index;
  bahsetmeListesiGoster(adaylar);
}

function bahsetmeListesiGoster(adaylar) {
  const kutu = $("bahsetme-listesi");
  kutu.innerHTML = "";
  adaylar.slice(0, 6).forEach((u) => {
    const oge = document.createElement("button");
    oge.type = "button";
    oge.className = "bahsetme-ogesi";
    oge.innerHTML = `<div class="avatar" style="width:26px;height:26px;font-size:11px;">${avatarIcerik(tumUyeler[u.uid])}</div><span>${kacir(u.ad)}</span>`;
    oge.addEventListener("mousedown", (e) => e.preventDefault()); // input'un blur olmasını engelle
    oge.addEventListener("click", () => bahsetmeSec(u.ad));
    kutu.appendChild(oge);
  });
  goster(kutu);
}

function bahsetmeListesiKapat() {
  sakla($("bahsetme-listesi"));
  bahsetmeBaslangicIndeks = -1;
}

function bahsetmeSec(ad) {
  const deger = girisKutu.value;
  const imlec = girisKutu.selectionStart;
  if (bahsetmeBaslangicIndeks < 0) { bahsetmeListesiKapat(); return; }
  const yeniDeger = deger.slice(0, bahsetmeBaslangicIndeks) + "@" + ad + " " + deger.slice(imlec);
  girisKutu.value = yeniDeger;
  const yeniImlec = bahsetmeBaslangicIndeks + ad.length + 2;
  girisKutu.focus();
  girisKutu.setSelectionRange(yeniImlec, yeniImlec);
  bahsetmeListesiKapat();
}

// Mesaj metnindeki @isim'leri, geçerli grup üyeleriyle eşleştirip uid listesine çevirir.
function metindenBahsedilenleriCikar(metin) {
  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  if (!s || s.tip !== "grup" || !metin) return [];
  const bulunanlar = [];
  (s.uyeler || []).forEach((uid) => {
    if (uid === suankiKullanici.uid) return;
    const ad = tumUyeler[uid]?.ad;
    if (!ad) return;
    const rx = new RegExp("@" + regexKacir(ad) + "(?![\\wçÇğĞıİöÖşŞüÜ])");
    if (rx.test(metin)) bulunanlar.push(uid);
  });
  return bulunanlar;
}

async function mesajGonder() {
  let metin = girisKutu.value.trim();
  if (!metin || !aktifSohbetId) return;
  if (metin.length > MESAJ_MAKS_KARAKTER) {
    metin = metin.slice(0, MESAJ_MAKS_KARAKTER);
  }
  if (!gonderimIzniVarMi()) return;
  girisKutu.value = "";
  girisKutu.style.height = "auto";

  if (duzenlenenMesajId) {
    const mesajId = duzenlenenMesajId;
    duzenlenenMesajId = null;
    sakla($("duzenleme-bandi"));
    const duzenlenenMesaj = mesajlarCache.find((x) => x.id === mesajId);
    const dMesajZamaniMs = duzenlenenMesaj?.zaman
      ? (duzenlenenMesaj.zaman.toDate ? duzenlenenMesaj.zaman.toDate().getTime() : new Date(duzenlenenMesaj.zaman).getTime())
      : 0;
    if (!dMesajZamaniMs || (Date.now() - dMesajZamaniMs) > MESAJ_DUZENLEME_SURESI_MS) {
      alert("Bu mesaj gönderileli 15 dakikadan uzun süre geçtiği için artık düzenlenemez.");
      // Kullanıcının yazdığı metni geri ver (kaybolmasın) ve düzenleme modunu koru.
      girisKutu.value = metin;
      girisKutu.style.height = "auto";
      girisKutu.style.height = girisKutu.scrollHeight + "px";
      duzenlenenMesajId = mesajId;
      goster($("duzenleme-bandi"));
      return;
    }
    try {
      await updateDoc(doc(db, "sohbetler", aktifSohbetId, "mesajlar", mesajId), {
        metin, duzenlendi: true
      });
      gonderimKaydet();
    } catch (err) {
      alert("Mesaj düzenlenemedi: " + err.message);
    }
    return;
  }

  const yanitAlani = yanitlananAlaniHazirla();
  yanitlaIptal();
  const bahsedilenler = metindenBahsedilenleriCikar(metin);

  await addDoc(collection(db, "sohbetler", aktifSohbetId, "mesajlar"), {
    gonderenUid: suankiKullanici.uid,
    tip: "metin",
    metin,
    ...yanitAlani,
    ...(bahsedilenler.length ? { bahsedilenler } : {}),
    ...kaybolmaAlaniHazirla(),
    zaman: serverTimestamp()
  });
  gonderimKaydet();
  await sohbetSonMesajGuncelle(metin, undefined, bahsedilenler);
}

// Aktif sohbette kaybolan mesaj açıksa, mesaja son-kullanma zamanı ekler.
function kaybolmaAlaniHazirla() {
  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  const saat = s?.kaybolmaSuresiSaat || 0;
  if (!saat) return {};
  return { sonKullanmaMs: Date.now() + saat * 3600 * 1000 };
}

async function sohbetSonMesajGuncelle(onizlemeMetni, sohbetIdParam, bahsedilenler) {
  const sohbetId = sohbetIdParam || aktifSohbetId;
  const s = sohbetlerCache.find((x) => x.id === sohbetId);
  const okunmamisGuncelle = {};
  (s?.uyeler || (!sohbetIdParam && aktifSohbetKarsi ? [suankiKullanici.uid, aktifSohbetKarsi] : [])).forEach((uid) => {
    if (uid === suankiKullanici.uid) return;
    okunmamisGuncelle[`okunmamis.${uid}`] = increment(1);
  });
  await updateDoc(doc(db, "sohbetler", sohbetId), {
    sonMesaj: onizlemeMetni,
    sonMesajZamani: serverTimestamp(),
    [`okunmamis.${suankiKullanici.uid}`]: 0,
    ...okunmamisGuncelle
  });
  aktifSohbetAlicilarinaBildir(onizlemeMetni, sohbetIdParam ? s : null, bahsedilenler);
}

// ---------- Ek menüsü (görsel / dosya / konum) ----------
$("ek-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("ek-menu");
  menu.classList.toggle("gizli");
  $("ek-btn").classList.toggle("acik", !menu.classList.contains("gizli"));
});
document.addEventListener("click", (e) => {
  if (!$("ek-menu").contains(e.target) && e.target !== $("ek-btn") && !$("ek-btn").contains(e.target)) {
    $("ek-menu").classList.add("gizli");
    $("ek-btn").classList.remove("acik");
  }
});

$("ek-menu-gorsel").addEventListener("click", () => {
  $("ek-menu").classList.add("gizli"); $("ek-btn").classList.remove("acik");
  $("dosya-input").click();
});
$("ek-menu-dosya").addEventListener("click", () => {
  $("ek-menu").classList.add("gizli"); $("ek-btn").classList.remove("acik");
  $("dosya-input-genel").click();
});

// ---------- Önizleme modalı: tek, mod tabanlı gönderme mantığı ----------
let onizlemeModu = null;     // 'dosya' | 'konum'
let onizlemeKonum = null;    // { lat, lng }

$("onizleme-gonder-btn").addEventListener("click", async () => {
  if (!gonderimIzniVarMi()) return;
  if (onizlemeModu === "dosya") {
    if (!secilenDosya || !aktifSohbetId) return;
    const dosya = secilenDosya;
    const tip = secilenDosyaTipi;
    const aciklama = $("onizleme-aciklama").value.trim().slice(0, MESAJ_MAKS_KARAKTER);
    sakla($("modal-onizleme"));
    secilenDosya = null;

    try {
      const url = await cloudinaryYukle(dosya);
      const yanitAlani = yanitlananAlaniHazirla();
      yanitlaIptal();
      await addDoc(collection(db, "sohbetler", aktifSohbetId, "mesajlar"), {
        gonderenUid: suankiKullanici.uid,
        tip, dosyaUrl: url, dosyaAd: dosya.name, metin: aciklama,
        ...yanitAlani,
        zaman: serverTimestamp()
      });
      gonderimKaydet();
      await sohbetSonMesajGuncelle(tip === "gorsel" ? "📷 Görsel" : "📎 " + dosya.name);
    } catch (err) {
      alert("Gönderilemedi: " + err.message);
    }
  } else if (onizlemeModu === "konum") {
    if (!onizlemeKonum || !aktifSohbetId) { alert("Konum henüz bulunamadı, biraz bekle."); return; }
    const not = $("onizleme-aciklama").value.trim().slice(0, MESAJ_MAKS_KARAKTER);
    sakla($("modal-onizleme"));
    $("onizleme-aciklama").placeholder = "Açıklama ekle (isteğe bağlı)";

    await addDoc(collection(db, "sohbetler", aktifSohbetId, "mesajlar"), {
      gonderenUid: suankiKullanici.uid,
      tip: "konum", lat: onizlemeKonum.lat, lng: onizlemeKonum.lng, metin: not,
      ...yanitlananAlaniHazirla(),
      zaman: serverTimestamp()
    });
    yanitlaIptal();
    gonderimKaydet();
    await sohbetSonMesajGuncelle("📍 Konum");
    onizlemeKonum = null;
  }
});

// ---------- Sesli mesaj kaydı ----------
let medyaKaydedici = null;
let sesParcalari = [];
let sesAkisi = null;
let sesKayitZamanlayici = null;
let sesKayitBaslangicMs = 0;
const SES_KAYIT_MAX_SN = 180; // 3 dakika sınırı

async function sesKayitBaslat() {
  if (!aktifSohbetId || medyaKaydedici) return;
  if (!navigator.mediaDevices || !window.MediaRecorder) {
    alert("Bu tarayıcı sesli mesaj kaydını desteklemiyor.");
    return;
  }
  try {
    sesAkisi = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    alert("Mikrofona erişilemedi: " + err.message);
    return;
  }

  sesParcalari = [];
  const mimeTip = (window.MediaRecorder.isTypeSupported && window.MediaRecorder.isTypeSupported("audio/webm"))
    ? "audio/webm" : "";
  medyaKaydedici = mimeTip ? new MediaRecorder(sesAkisi, { mimeType: mimeTip }) : new MediaRecorder(sesAkisi);
  medyaKaydedici.addEventListener("dataavailable", (e) => { if (e.data && e.data.size > 0) sesParcalari.push(e.data); });
  medyaKaydedici.start();
  sesKayitBaslangicMs = Date.now();

  $("giris-normal-kontroller").classList.add("gizli");
  goster($("ses-kayit-bandi"));
  $("ses-kayit-sure").textContent = "0:00";

  sesKayitZamanlayici = setInterval(() => {
    const saniye = Math.floor((Date.now() - sesKayitBaslangicMs) / 1000);
    const dk = Math.floor(saniye / 60);
    const sn = saniye % 60;
    $("ses-kayit-sure").textContent = `${dk}:${String(sn).padStart(2, "0")}`;
    if (saniye >= SES_KAYIT_MAX_SN) sesKayitGonder();
  }, 250);
}

function sesKayitDurdurVeAl() {
  return new Promise((resolve) => {
    medyaKaydedici.addEventListener("stop", () => {
      resolve(new Blob(sesParcalari, { type: medyaKaydedici.mimeType || "audio/webm" }));
    }, { once: true });
    medyaKaydedici.stop();
  });
}

function sesKayitTemizle() {
  clearInterval(sesKayitZamanlayici);
  sesKayitZamanlayici = null;
  if (sesAkisi) sesAkisi.getTracks().forEach((t) => t.stop());
  sesAkisi = null;
  medyaKaydedici = null;
  sesParcalari = [];
  sakla($("ses-kayit-bandi"));
  $("giris-normal-kontroller").classList.remove("gizli");
}

$("ses-kayit-btn").addEventListener("click", sesKayitBaslat);

$("ses-kayit-iptal").addEventListener("click", () => {
  if (medyaKaydedici && medyaKaydedici.state !== "inactive") medyaKaydedici.stop();
  sesKayitTemizle();
});

$("ses-kayit-gonder").addEventListener("click", sesKayitGonder);

async function sesKayitGonder() {
  if (!medyaKaydedici || medyaKaydedici.state === "inactive") return;
  const sohbetId = aktifSohbetId;
  const sureSn = Math.max(1, Math.round((Date.now() - sesKayitBaslangicMs) / 1000));
  const blob = await sesKayitDurdurVeAl();
  sesKayitTemizle();
  if (!sohbetId || blob.size < 800) return; // çok kısa/boş kayıt — gönderme
  if (!gonderimIzniVarMi()) return;

  try {
    const uzanti = (blob.type && blob.type.includes("ogg")) ? "ogg" : "webm";
    const dosya = new File([blob], `ses-mesaji-${Date.now()}.${uzanti}`, { type: blob.type });
    const url = await cloudinaryYukle(dosya);
    const yanitAlani = yanitlananAlaniHazirla();
    yanitlaIptal();
    await addDoc(collection(db, "sohbetler", sohbetId, "mesajlar"), {
      gonderenUid: suankiKullanici.uid,
      tip: "ses",
      dosyaUrl: url,
      sureSn,
      ...yanitAlani,
      zaman: serverTimestamp()
    });
    gonderimKaydet();
    await sohbetSonMesajGuncelle(`🎤 Sesli mesaj (${Math.floor(sureSn / 60)}:${String(sureSn % 60).padStart(2, "0")})`);
  } catch (err) {
    alert("Sesli mesaj gönderilemedi: " + err.message);
  }
}


let secilenDosya = null, secilenDosyaTipi = null; // 'gorsel' | 'dosya'

$("dosya-input").addEventListener("change", async (e) => {
  const dosya = e.target.files[0];
  e.target.value = "";
  if (!dosya) return;
  if (dosya.size > 50 * 1024 * 1024) { alert("Görsel 50MB'tan büyük olamaz."); return; }

  secilenDosyaTipi = "gorsel";
  onizlemeModu = "dosya";
  $("onizleme-baslik").textContent = "Görsel gönder";
  $("onizleme-icerik").innerHTML = `<div class="onizleme-gorsel-kutu" style="display:flex;align-items:center;justify-content:center;min-height:80px;color:var(--metin-soluk);font-size:13px;">🗜️ Sıkıştırılıyor…</div>`;
  $("onizleme-aciklama").value = "";
  goster($("modal-onizleme"));

  try {
    const sikistirilmis = await gorseliSikistir(dosya);
    secilenDosya = sikistirilmis;
    const url = URL.createObjectURL(sikistirilmis);
    const orijinalKb = (dosya.size / 1024).toFixed(0);
    const yeniKb = (sikistirilmis.size / 1024).toFixed(0);
    const bilgi = orijinalKb !== yeniKb
      ? `<div style="font-size:11px;color:var(--metin-soluk);margin-top:4px;">Orijinal: ${orijinalKb} KB → Gönderilecek: ${yeniKb} KB</div>`
      : "";
    $("onizleme-icerik").innerHTML = `<div class="onizleme-gorsel-kutu"><img src="${url}" />${bilgi}</div>`;
  } catch (err) {
    $("onizleme-icerik").innerHTML = `<div style="color:#E5484D;font-size:13px;">Görsel işlenemedi: ${err.message}</div>`;
  }
});

$("dosya-input-genel").addEventListener("change", (e) => {
  const dosya = e.target.files[0];
  e.target.value = "";
  if (!dosya) return;
  if (dosya.size > 10 * 1024 * 1024) { alert("Dosya boyutu en fazla 10 MB olabilir."); return; }
  secilenDosya = dosya;
  secilenDosyaTipi = "dosya";
  onizlemeModu = "dosya";

  const boyutMb = (dosya.size / (1024 * 1024)).toFixed(1);
  $("onizleme-baslik").textContent = "Dosya gönder";
  $("onizleme-icerik").innerHTML = `
    <div class="onizleme-dosya-kutu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>
      <div>
        <div class="dosya-bilgi-ad">${kacir(dosya.name)}</div>
        <div class="dosya-bilgi-boyut">${boyutMb} MB</div>
      </div>
    </div>`;
  $("onizleme-aciklama").value = "";
  goster($("modal-onizleme"));
});

// ---------- Konum gönderme ----------
$("ek-menu-konum").addEventListener("click", () => {
  $("ek-menu").classList.add("gizli"); $("ek-btn").classList.remove("acik");
  if (!aktifSohbetId) return;
  if (!navigator.geolocation) { alert("Tarayıcınız konum özelliğini desteklemiyor."); return; }

  onizlemeModu = "konum";
  onizlemeKonum = null;

  $("onizleme-baslik").textContent = "Konum gönder";
  $("onizleme-aciklama").value = "";
  $("onizleme-aciklama").placeholder = "Not ekle (isteğe bağlı)";
  goster($("modal-onizleme"));

  // İzin daha önceden verilmiş ve arka plan konum takibi açıksa, en son bilinen
  // konumu anında önizlemede göster (izin penceresi/GPS ölçümü beklenmez);
  // ardından daha taze bir ölçüm geldiğinde önizleme otomatik güncellenir.
  if (sonBilinenKonum) {
    onizlemeKonum = { lat: sonBilinenKonum.lat, lng: sonBilinenKonum.lng };
    const haritaUrl = staticHaritaUrl(onizlemeKonum.lat, onizlemeKonum.lng);
    $("onizleme-icerik").innerHTML = `
      <div class="onizleme-konum-kutu" style="flex-direction:column;align-items:stretch;">
        <img src="${haritaUrl}" style="border-radius:8px;width:100%;" alt="harita önizleme" />
        <div style="margin-top:8px;font-size:12.5px;color:var(--metin-soluk);">Şu anki konumun gönderilecek.</div>
      </div>`;
  } else {
    $("onizleme-icerik").innerHTML = `
      <div class="onizleme-konum-kutu">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
        <div>Konumun bulunuyor...</div>
      </div>`;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      onizlemeKonum = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const haritaUrl = staticHaritaUrl(onizlemeKonum.lat, onizlemeKonum.lng);
      $("onizleme-icerik").innerHTML = `
        <div class="onizleme-konum-kutu" style="flex-direction:column;align-items:stretch;">
          <img src="${haritaUrl}" style="border-radius:8px;width:100%;" alt="harita önizleme" />
          <div style="margin-top:8px;font-size:12.5px;color:var(--metin-soluk);">Şu anki konumun gönderilecek.</div>
        </div>`;
    },
    () => {
      if (!onizlemeKonum) {
        $("onizleme-icerik").innerHTML = `<div class="onizleme-konum-kutu">Konum alınamadı. Tarayıcı/telefon konum izni vermiş mi kontrol et.</div>`;
      }
      // onizlemeKonum zaten önbellekten doluysa (sonBilinenKonum), taze ölçüm
      // başarısız olsa da önizlemede gösterilen konum geçerliliğini korur.
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

// Konum koordinatlarını (Firestore'dan/kullanıcı cihazından gelen ham değeri)
// güvenli bir sayıya çevirir; geçersiz/bozuk bir değer gelirse 0 döner.
// Ardından bu sayılar her zaman URLSearchParams/encodeURIComponent üzerinden
// URL'ye yazılır — ham string birleştirme yerine, temiz ve tutarlı bir yöntem.
function konumSayi(deger) {
  const n = Number(deger);
  return Number.isFinite(n) ? n : 0;
}

function staticHaritaUrl(lat, lng, genislik = 320, yukseklik = 160) {
  const la = konumSayi(lat), ln = konumSayi(lng);
  const params = new URLSearchParams({
    center: `${la},${ln}`,
    zoom: "15",
    size: `${genislik}x${yukseklik}`,
    markers: `${la},${ln},red-pushpin`
  });
  return `https://staticmap.openstreetmap.de/staticmap.php?${params.toString()}`;
}

function osmHaritaLinki(lat, lng) {
  const la = konumSayi(lat), ln = konumSayi(lng);
  const params = new URLSearchParams({ mlat: String(la), mlon: String(ln) });
  return `https://www.openstreetmap.org/?${params.toString()}#map=16/${la}/${ln}`;
}

// ============================================================
// MEDYA GALERİSİ (sohbette gönderilmiş tüm görseller)
// ============================================================
let medyaGaleriListesi = [];
let medyaLightboxIndeks = -1;

$("medya-galeri-btn").addEventListener("click", () => {
  medyaGaleriListesi = mesajlarCache
    .filter((m) => m.tip === "gorsel" && !m.silindi && m.dosyaUrl)
    .slice()
    .reverse(); // en yeni en üstte

  const izgara = $("medya-galeri-izgara");
  izgara.innerHTML = "";
  if (!medyaGaleriListesi.length) {
    izgara.innerHTML = `<div class="bos-liste" style="grid-column:1/-1;">Bu sohbette henüz görsel paylaşılmamış.</div>`;
  } else {
    medyaGaleriListesi.forEach((m, i) => {
      const oge = document.createElement("div");
      oge.className = "medya-galeri-oge";
      oge.innerHTML = `<img src="${m.dosyaUrl}" alt="" loading="lazy" />`;
      oge.addEventListener("click", () => medyaLightboxAc(i));
      izgara.appendChild(oge);
    });
  }
  goster($("modal-medya-galeri"));
});

function medyaLightboxAc(indeks) {
  if (!medyaGaleriListesi.length) return;
  medyaLightboxIndeks = (indeks + medyaGaleriListesi.length) % medyaGaleriListesi.length;
  medyaLightboxGuncelle();
  goster($("medya-lightbox"));
}
function medyaLightboxGuncelle() {
  const m = medyaGaleriListesi[medyaLightboxIndeks];
  if (!m) return;
  $("medya-lightbox-img").src = m.dosyaUrl;
  $("medya-lightbox-sayac").textContent = `${medyaLightboxIndeks + 1} / ${medyaGaleriListesi.length}`;
}
function medyaLightboxKapat() {
  sakla($("medya-lightbox"));
  $("medya-lightbox-img").src = "";
}
$("medya-lightbox-kapat").addEventListener("click", medyaLightboxKapat);
$("medya-lightbox-onceki").addEventListener("click", () => medyaLightboxAc(medyaLightboxIndeks - 1));
$("medya-lightbox-sonraki").addEventListener("click", () => medyaLightboxAc(medyaLightboxIndeks + 1));
$("medya-lightbox").addEventListener("click", (e) => {
  if (e.target.id === "medya-lightbox") medyaLightboxKapat();
});
document.addEventListener("keydown", (e) => {
  if ($("medya-lightbox").classList.contains("gizli")) return;
  if (e.key === "Escape") medyaLightboxKapat();
  else if (e.key === "ArrowLeft") medyaLightboxAc(medyaLightboxIndeks - 1);
  else if (e.key === "ArrowRight") medyaLightboxAc(medyaLightboxIndeks + 1);
});

// ============================================================
// GRUPLAR
// ============================================================
$("yeni-grup-btn").addEventListener("click", () => {
  const liste = $("grup-uye-secim-listesi");
  liste.innerHTML = "";
  Object.entries(tumUyeler)
    .filter(([uid]) => uid !== suankiKullanici.uid)
    .sort((a, b) => (a[1].ad || "").localeCompare(b[1].ad || ""))
    .forEach(([uid, veri]) => {
      const satir = document.createElement("label");
      satir.className = "uye-secim-ogesi";
      satir.innerHTML = `<input type="checkbox" value="${uid}" /> <div class="avatar" style="width:32px;height:32px;font-size:13px;">${avatarIcerik(veri)}</div> ${kacir(veri.ad)}`;
      liste.appendChild(satir);
    });
  $("grup-ad-input").value = "";
  goster($("modal-grup"));
});

$("grup-olustur-btn").addEventListener("click", async () => {
  const ad = $("grup-ad-input").value.trim();
  const secilenler = [...document.querySelectorAll('#grup-uye-secim-listesi input:checked')].map((i) => i.value);
  if (!ad) { alert("Grup adı gir."); return; }
  if (secilenler.length === 0) { alert("En az 1 üye seç."); return; }

  const uyeler = [suankiKullanici.uid, ...secilenler];
  const yeniRef = await addDoc(collection(db, "sohbetler"), {
    tip: "grup",
    ad,
    uyeler,
    olusturanUid: suankiKullanici.uid,
    sonMesaj: "Grup oluşturuldu",
    sonMesajZamani: serverTimestamp(),
    olusturulmaZamani: serverTimestamp()
  });
  sakla($("modal-grup"));
  sohbetAc(yeniRef.id, "grup", null);
});

$("grup-uyeler-btn").addEventListener("click", () => {
  grupUyelerModaliniDoldur();
  goster($("modal-grup-uyeler"));
});

let grupFotoSecilen = null;

function grupUyelerModaliniDoldur() {
  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  if (!s) return;
  const benKurucuMu = s.olusturanUid === suankiKullanici.uid;

  $("grup-uyeler-baslik").textContent = (s.ad || "Grup") + " — üyeler";

  // Kurucu için ad/foto düzenleme alanı
  grupFotoSecilen = null;
  if (benKurucuMu) {
    goster($("grup-duzenle-alani"));
    $("grup-ad-duzenle-input").value = s.ad || "";
    $("grup-foto-onizleme").innerHTML = s.grupFotoUrl ? `<img src="${s.grupFotoUrl}" alt="" />` : harfBas(s.ad || "Grup");
  } else {
    sakla($("grup-duzenle-alani"));
  }

  // Üye listesi
  const liste = $("grup-uyeler-listesi");
  liste.innerHTML = "";
  s.uyeler.forEach((uid) => {
    const veri = tumUyeler[uid] || {};
    const benMi = uid === suankiKullanici.uid;
    const satir = document.createElement("div");
    satir.className = "uye-secim-ogesi";
    satir.innerHTML = `
      <div class="avatar" style="width:32px;height:32px;font-size:13px;">${avatarIcerik(veri)}</div>
      <div class="ad-kutu">${kacir(veri.ad || "Üye")}${benMi ? " (sen)" : ""}</div>
      ${(benKurucuMu && !benMi) ? `<button class="uye-cikar-btn" data-uid="${uid}">Çıkar</button>` : ""}`;
    liste.appendChild(satir);
  });
  liste.querySelectorAll(".uye-cikar-btn").forEach((btn) => {
    btn.addEventListener("click", () => grupUyesiCikar(btn.dataset.uid));
  });

  // "Üye ekle" alanını sıfırla/kapat
  sakla($("grup-uye-ekle-listesi"));
  sakla($("grup-uye-ekle-kaydet-btn"));
  $("grup-uye-ekle-ac-btn").textContent = "+ Üye ekle";
}

async function grupUyesiCikar(uid) {
  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  if (!s) return;
  if (!confirm(`${tumUyeler[uid]?.ad || "Bu üyeyi"} gruptan çıkarmak istediğine emin misin?`)) return;
  try {
    await updateDoc(doc(db, "sohbetler", s.id), { uyeler: arrayRemove(uid) });
    grupUyelerModaliniDoldur();
  } catch (err) {
    alert("Üye çıkarılamadı: " + err.message);
  }
}

$("grup-uye-ekle-ac-btn").addEventListener("click", () => {
  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  if (!s) return;
  const liste = $("grup-uye-ekle-listesi");
  const acikMi = !liste.classList.contains("gizli");
  if (acikMi) {
    sakla(liste); sakla($("grup-uye-ekle-kaydet-btn"));
    $("grup-uye-ekle-ac-btn").textContent = "+ Üye ekle";
    return;
  }
  liste.innerHTML = "";
  Object.entries(tumUyeler)
    .filter(([uid]) => !s.uyeler.includes(uid))
    .sort((a, b) => (a[1].ad || "").localeCompare(b[1].ad || ""))
    .forEach(([uid, veri]) => {
      const satir = document.createElement("label");
      satir.className = "uye-secim-ogesi";
      satir.innerHTML = `<input type="checkbox" value="${uid}" /> <div class="avatar" style="width:32px;height:32px;font-size:13px;">${avatarIcerik(veri)}</div> ${kacir(veri.ad)}`;
      liste.appendChild(satir);
    });
  if (liste.children.length === 0) {
    liste.innerHTML = `<div class="bos-liste">Eklenecek başka aile üyesi yok.</div>`;
  }
  goster(liste); goster($("grup-uye-ekle-kaydet-btn"));
  $("grup-uye-ekle-ac-btn").textContent = "Vazgeç";
});

$("grup-uye-ekle-kaydet-btn").addEventListener("click", async () => {
  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  if (!s) return;
  const secilenler = [...document.querySelectorAll("#grup-uye-ekle-listesi input:checked")].map((i) => i.value);
  if (secilenler.length === 0) { alert("En az 1 üye seç."); return; }
  // arrayUnion spread güvenliği: Firestore tek belgede max 20.000 alan destekler;
  // pratikte aile uygulaması için 50 üye üst sınır fazlasıyla yeterli.
  const mevcutSayi = (s.uyeler || []).length;
  if (mevcutSayi + secilenler.length > 50) {
    alert("Grup üye sayısı 50'yi geçemez.");
    return;
  }
  try {
    await updateDoc(doc(db, "sohbetler", s.id), { uyeler: arrayUnion(...secilenler) });
    grupUyelerModaliniDoldur();
  } catch (err) {
    alert("Üyeler eklenemedi: " + err.message);
  }
});

$("grup-foto-sec-btn").addEventListener("click", () => $("grup-foto-input").click());
$("grup-foto-input").addEventListener("change", async (e) => {
  const dosya = e.target.files[0];
  e.target.value = "";
  if (!dosya) return;
  if (dosya.size > 20 * 1024 * 1024) { alert("Fotoğraf 20MB'tan büyük olamaz."); return; }
  try {
    grupFotoSecilen = await gorseliSikistir(dosya);
    $("grup-foto-onizleme").innerHTML = `<img src="${URL.createObjectURL(grupFotoSecilen)}" />`;
  } catch { grupFotoSecilen = dosya; }
});

$("grup-bilgi-kaydet-btn").addEventListener("click", async () => {
  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  if (!s) return;
  const yeniAd = $("grup-ad-duzenle-input").value.trim();
  if (!yeniAd) { alert("Grup adı boş olamaz."); return; }

  const guncelleme = { ad: yeniAd };
  try {
    if (grupFotoSecilen) {
      guncelleme.grupFotoUrl = await cloudinaryYukle(grupFotoSecilen);
    }
    await updateDoc(doc(db, "sohbetler", s.id), guncelleme);
    grupFotoSecilen = null;
    grupUyelerModaliniDoldur();
    sohbetBasligiGuncelle();
  } catch (err) {
    alert("Kaydedilemedi: " + err.message);
  }
});

$("gruptan-ayril-btn").addEventListener("click", async () => {
  const s = sohbetlerCache.find((x) => x.id === aktifSohbetId);
  if (!s) return;
  if (!confirm("Bu gruptan ayrılmak istediğine emin misin?")) return;
  try {
    await updateDoc(doc(db, "sohbetler", s.id), { uyeler: arrayRemove(suankiKullanici.uid) });
    sakla($("modal-grup-uyeler"));
    aktifSohbetId = null;
    aktifSohbetTipi = null;
    sakla($("sohbet-aktif"));
    goster($("karsilama-ekrani"));
    $("panel-liste").classList.remove("gizli-mobil");
    $("panel-sohbet").classList.add("gizli-mobil");
  } catch (err) {
    alert("Gruptan ayrılamadı: " + err.message);
  }
});

// ============================================================
// DAVETİYE SİSTEMİ (kapalı üyelik — dışarıdan kimse giremez)
// ============================================================
$("davet-olustur-btn").addEventListener("click", () => {
  $("davet-kod-cikti").innerHTML = "";
  goster($("modal-davet"));
});

$("davet-kod-uret-btn").addEventListener("click", async () => {
  const kod = rastgeleKod(8);
  const simdi = Date.now();
  const bitis = simdi + 48 * 60 * 60 * 1000; // 48 saat
  await setDoc(doc(db, "davetler", kod), {
    kod,
    olusturanUid: suankiKullanici.uid,
    olusturanAd: suankiKullanici.ad,
    kullanildi: false,
    olusturulmaZamani: serverTimestamp(),
    expiresAt: bitis
  });
  const sayfaUrl = location.href.split("?")[0].split("#")[0];
  const davetLink = `${sayfaUrl}?d=${kod}`;
  $("davet-kod-cikti").innerHTML = `
    <div class="davet-kod-kutusu">
      <div class="kod">${kod}</div>
      <div class="aciklama">Aşağıdaki bağlantıyı kişiye gönder — tıklayınca kod otomatik dolar. Bağlantı <strong>48 saat</strong> geçerlidir.</div>
      <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn-ikincil" onclick="navigator.clipboard.writeText('${davetLink}').then(()=>{this.textContent='✓ Kopyalandı';setTimeout(()=>{this.textContent='🔗 Bağlantıyı kopyala'},2000)})">🔗 Bağlantıyı kopyala</button>
        <button class="btn-ikincil" onclick="navigator.clipboard.writeText('${kod}').then(()=>{this.textContent='✓ Kopyalandı';setTimeout(()=>{this.textContent='📋 Sadece kodu kopyala'},2000)})">📋 Sadece kodu kopyala</button>
      </div>
    </div>`;
});

// ---------- Modal kapama (ortak) ----------
document.querySelectorAll(".modal-kapat").forEach((btn) => {
  btn.addEventListener("click", () => sakla(document.getElementById(btn.dataset.modal)));
});
document.querySelectorAll(".modal-perde").forEach((perde) => {
  perde.addEventListener("click", (e) => { if (e.target === perde) sakla(perde); });
});

// ============================================================
// SESLİ / GÖRÜNTÜLÜ ARAMA (WebRTC + Firestore sinyalleşme)
// ============================================================

$("sesli-arama-btn").addEventListener("click", () => aramaBaslat("sesli"));
$("goruntulu-arama-btn").addEventListener("click", () => aramaBaslat("goruntulu"));

async function aramaBaslat(tip) {
  if (aktifSohbetTipi !== "birebir") {
    alert("Şu an grup araması desteklenmiyor. Lütfen birebir sohbetten arayın.");
    return;
  }
  if (aktifAramaId) { alert("Zaten bir aramadasın."); return; }

  aramaTipi = tip;
  aramaRolu = "arayan";
  const aramaRef = await addDoc(collection(db, "aramalar"), {
    arayanUid: suankiKullanici.uid,
    arayanAd: suankiKullanici.ad,
    arananUid: aktifSohbetKarsi,
    tip,
    durum: "cagiriliyor",
    olusturulmaZamani: serverTimestamp()
  });
  aktifAramaId = aramaRef.id;
  pushBildirimGonder(
    [aktifSohbetKarsi],
    suankiKullanici.ad,
    tip === "sesli" ? "📞 Sesli arama..." : "📹 Görüntülü arama...",
    "kakule-arama",
    null,
    true
  );

  await aramaKatmaniniAc(tip, tumUyeler[aktifSohbetKarsi], "Aranıyor...");

  pc = new RTCPeerConnection(RTC_AYARLAR);
  icePcIzle(pc);
  uzakStreamDinle(pc);

  try {
    await yerelStreamEkle(pc, tip);
  } catch {
    await updateDoc(aramaRef, { durum: "bitti" }).catch(() => {});
    aramayiKapat("Mikrofon/kamera izni gerekiyor");
    return;
  }

  const arayanAdaylar = collection(db, "aramalar", aktifAramaId, "arayanAdaylar");
  pc.onicecandidate = (e) => { if (e.candidate) addDoc(arayanAdaylar, e.candidate.toJSON()); };

  const teklif = await pc.createOffer();
  await pc.setLocalDescription(teklif);
  await updateDoc(aramaRef, { offer: { type: teklif.type, sdp: teklif.sdp } });

  // Cevapsız arama zaman aşımı: süre dolana kadar karşı taraf cevap vermezse aramayı otomatik kapat.
  clearTimeout(aramaZamanasimiId);
  aramaZamanasimiId = setTimeout(async () => {
    if (aktifAramaId === aramaRef.id && pc && !pc.currentRemoteDescription) {
      await updateDoc(aramaRef, { durum: "cevapsiz" }).catch(() => {});
      aramayiKapat("Cevap yok");
    }
  }, ARAMA_ZAMANASIMI_MS);

  // Karşı taraf cevaplayınca
  const durdur1 = onSnapshot(doc(db, "aramalar", aktifAramaId), async (snap) => {
    const veri = snap.data();
    if (!veri) return;
    if (veri.answer && pc && !pc.currentRemoteDescription) {
      clearTimeout(aramaZamanasimiId);
      await pc.setRemoteDescription(new RTCSessionDescription(veri.answer));
      $("arama-durum").textContent = aramaTipi === "sesli" ? "Sesli arama bağlandı" : "Görüntülü arama bağlandı";
    }
    if (veri.durum === "red") { aramayiKapat("Arama reddedildi"); }
    if (veri.durum === "bitti") { aramayiKapat("Arama sona erdi"); }
    if (veri.durum === "cevapsiz") { aramayiKapat("Cevap yok"); }
  });
  const durdur2 = onSnapshot(collection(db, "aramalar", aktifAramaId, "arananAdaylar"), (snap) => {
    snap.docChanges().forEach((c) => {
      if (c.type === "added") pc.addIceCandidate(new RTCIceCandidate(c.doc.data())).catch(() => {});
    });
  });
  aramaAbonelikler.push(durdur1, durdur2);
}

async function yerelStreamEkle(pcNesnesi, tip) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: tip === "goruntulu" });
  } catch {
    alert("Mikrofon/kamera izni gerekiyor.");
    throw new Error("getUserMedia başarısız");
  }
  yerelStream = stream;
  stream.getTracks().forEach((track) => pcNesnesi.addTrack(track, stream));
  if (tip === "goruntulu") {
    $("yerel-video").srcObject = stream;
    goster($("yerel-video"));
  }
}

// Bağlantı durumunu izler: kopma/başarısızlık durumunda kullanıcıyı bilgilendirir.
function icePcIzle(pcNesnesi) {
  pcNesnesi.oniceconnectionstatechange = () => {
    const durum = pcNesnesi.iceConnectionState;
    if (durum === "disconnected") {
      $("arama-durum").textContent = "Bağlantı zayıf, yeniden bağlanılıyor...";
    } else if (durum === "failed") {
      $("arama-durum").textContent = "Bağlantı kurulamadı";
      aramayiKapat("Bağlantı koptu");
    }
  };
}

function uzakStreamDinle(pcNesnesi) {
  const uzakStream = new MediaStream();
  pcNesnesi.ontrack = (e) => {
    uzakStream.addTrack(e.track);
    $("uzak-video").srcObject = uzakStream;
    if (e.track.kind === "video") {
      goster($("uzak-video"));
      // Karşı taraf kamerasını kapatınca track "mute" olur (donmuş kare kalır);
      // bu durumda videoyu gizleyip avatarı gösteriyoruz, açınca tersini.
      const avatarGuncelle = () => {
        const kapali = e.track.muted;
        $("uzak-avatar").classList.toggle("gizli", !kapali);
        $("uzak-video").classList.toggle("gizli", kapali);
      };
      e.track.onmute = avatarGuncelle;
      e.track.onunmute = avatarGuncelle;
      avatarGuncelle();
    }
  };
}

async function aramaKatmaniniAc(tip, karsiVeri, durumMetni) {
  $("arama-ad").textContent = karsiVeri?.ad || "Aile üyesi";
  $("arama-avatar").innerHTML = avatarIcerik(karsiVeri);
  // Uzak video kapanınca gösterilecek büyük avatarı da karşı tarafa göre hazırla.
  $("uzak-avatar").innerHTML = avatarIcerik(karsiVeri);
  $("arama-durum").textContent = durumMetni;
  sakla($("uzak-video")); sakla($("yerel-video")); sakla($("uzak-avatar"));
  $("arama-kamera-btn").classList.toggle("gizli", tip !== "goruntulu");
  goster($("arama-katmani"));
}

// ---------- Gelen arama ----------
function gelenAramalariDinle() {
  const q = query(
    collection(db, "aramalar"),
    where("arananUid", "==", suankiKullanici.uid),
    where("durum", "==", "cagiriliyor")
  );
  onSnapshot(q, (snap) => {
    snap.docChanges().forEach((c) => {
      if (c.type === "added") gelenAramaBildirGoster(c.doc.id, c.doc.data());
      // Belge artık "cagiriliyor" durumunda değil (arayan iptal etti / zaman aşımına uğradı / reddedildi).
      // Henüz katılmadıysak ekrandaki bildirimi kapat.
      if (c.type === "removed" && c.doc.id === gosterilenGelenAramaId && !aktifAramaId) {
        sakla($("gelen-arama-bildirimi"));
        gosterilenGelenAramaId = null;
      }
    });
  });
}

function gelenAramaBildirGoster(aramaId, veri) {
  if (aktifAramaId) return; // zaten bir aramadayız
  gosterilenGelenAramaId = aramaId;
  const arayanVeri = tumUyeler[veri.arayanUid] || { ad: veri.arayanAd };
  $("gelen-arama-ad").textContent = arayanVeri.ad || "Aile üyesi";
  $("gelen-arama-avatar").innerHTML = avatarIcerik(arayanVeri);
  $("gelen-arama-tip").textContent = veri.tip === "sesli" ? "Sesli arama" : "Görüntülü arama";
  // Arama-tipi gradyan rozeti: yalnız sesli aramada göster (görüntülü için ayrı ikon yok)
  const tipRozet = document.querySelector(".gelen-arama-tip-rozet");
  if (tipRozet) tipRozet.style.display = veri.tip === "sesli" ? "block" : "none";
  goster($("gelen-arama-bildirimi"));

  $("arama-kabul-btn").onclick = async () => {
    gosterilenGelenAramaId = null;
    sakla($("gelen-arama-bildirimi"));
    await aramayaKatil(aramaId, veri);
  };
  $("arama-red-btn").onclick = async () => {
    gosterilenGelenAramaId = null;
    sakla($("gelen-arama-bildirimi"));
    await updateDoc(doc(db, "aramalar", aramaId), { durum: "red" });
  };
}

async function aramayaKatil(aramaId, veri) {
  aktifAramaId = aramaId;
  aramaRolu = "arayan-degil";
  aramaTipi = veri.tip;

  await aramaKatmaniniAc(veri.tip, tumUyeler[veri.arayanUid] || { ad: veri.arayanAd }, "Bağlanıyor...");

  pc = new RTCPeerConnection(RTC_AYARLAR);
  icePcIzle(pc);
  uzakStreamDinle(pc);

  try {
    await yerelStreamEkle(pc, veri.tip);
  } catch {
    await updateDoc(doc(db, "aramalar", aramaId), { durum: "bitti" }).catch(() => {});
    aramayiKapat("Mikrofon/kamera izni gerekiyor");
    return;
  }

  const arananAdaylar = collection(db, "aramalar", aramaId, "arananAdaylar");
  pc.onicecandidate = (e) => { if (e.candidate) addDoc(arananAdaylar, e.candidate.toJSON()); };

  await pc.setRemoteDescription(new RTCSessionDescription(veri.offer));
  const cevap = await pc.createAnswer();
  await pc.setLocalDescription(cevap);
  await updateDoc(doc(db, "aramalar", aramaId), {
    answer: { type: cevap.type, sdp: cevap.sdp },
    durum: "kabul"
  });
  $("arama-durum").textContent = veri.tip === "sesli" ? "Sesli arama bağlandı" : "Görüntülü arama bağlandı";

  const durdur1 = onSnapshot(collection(db, "aramalar", aramaId, "arayanAdaylar"), (snap) => {
    snap.docChanges().forEach((c) => {
      if (c.type === "added") pc.addIceCandidate(new RTCIceCandidate(c.doc.data())).catch(() => {});
    });
  });
  const durdur2 = onSnapshot(doc(db, "aramalar", aramaId), (snap) => {
    const d = snap.data()?.durum;
    if (d === "bitti" || d === "cevapsiz") aramayiKapat("Arama sona erdi");
  });
  aramaAbonelikler.push(durdur1, durdur2);
}

$("arama-kapat-btn").addEventListener("click", async () => {
  if (aktifAramaId) {
    await updateDoc(doc(db, "aramalar", aktifAramaId), { durum: "bitti" }).catch(() => {});
  }
  aramayiKapat("Arama sona erdi");
});

let mikrofonAcik = true, kameraAcik = true;
$("arama-mikrofon-btn").addEventListener("click", () => {
  mikrofonAcik = !mikrofonAcik;
  yerelStream?.getAudioTracks().forEach((t) => (t.enabled = mikrofonAcik));
  $("arama-mikrofon-btn").classList.toggle("aktif-degil", !mikrofonAcik);
});
$("arama-kamera-btn").addEventListener("click", () => {
  kameraAcik = !kameraAcik;
  yerelStream?.getVideoTracks().forEach((t) => (t.enabled = kameraAcik));
  $("arama-kamera-btn").classList.toggle("aktif-degil", !kameraAcik);
});

function aramayiKapat(sebep) {
  clearTimeout(aramaZamanasimiId);
  aramaZamanasimiId = null;
  if (pc) { pc.close(); pc = null; }
  if (yerelStream) { yerelStream.getTracks().forEach((t) => t.stop()); yerelStream = null; }
  aramaAbonelikler.forEach((fn) => fn());
  aramaAbonelikler = [];

  // Firestore temizliği: bu aramanın belgesini ve ICE aday alt-koleksiyonlarını
  // sil. SDP offer/answer IP adresi sızdırır ve belgeler süresiz birikir; arama
  // bittiğine göre artık gereksizler. Ana belgeyi yalnızca arayan taraf siler
  // (iki tarafın aynı belgeyi silmeye çalışıp çakışmasını önlemek için).
  const kapatilanAramaId = aktifAramaId;
  const kapatilanRol = aramaRolu;
  if (kapatilanAramaId) {
    aramaBelgesiTemizle(kapatilanAramaId, kapatilanRol).catch(() => {});
  }

  aktifAramaId = null;
  aramaRolu = null;
  mikrofonAcik = true; kameraAcik = true;
  $("arama-mikrofon-btn").classList.remove("aktif-degil");
  $("arama-kamera-btn").classList.remove("aktif-degil");
  $("uzak-avatar")?.classList.add("gizli");
  sakla($("arama-katmani"));
  // sebep ileride kullanıcıya kısa bir bilgi olarak gösterilebilir; şimdilik
  // parametreyi kabul ediyoruz ki çağıranların verdiği metin sessizce düşmesin.
  if (sebep) { /* opsiyonel: son arama durumunu bir yerde göstermek için ayrılmış */ }
}

// Bir aramanın Firestore ayak izini temizler (belge + iki aday alt-koleksiyonu).
async function aramaBelgesiTemizle(aramaId, rol) {
  const altKoleksiyonSil = async (ad) => {
    try {
      const snap = await getDocs(collection(db, "aramalar", aramaId, ad));
      await Promise.all(snap.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
    } catch { /* yoksay */ }
  };
  await Promise.all([altKoleksiyonSil("arayanAdaylar"), altKoleksiyonSil("arananAdaylar")]);
  // Ana belgeyi yalnızca arayan siler (durum artık bitti/cevapsiz/red olmalı;
  // firestore.rules bunu zorunlu kılıyor).
  if (rol === "arayan") {
    await deleteDoc(doc(db, "aramalar", aramaId)).catch(() => {});
  }
}

// ============================================================
// SERVICE WORKER (PWA)
// ============================================================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

// ============================================================
// PROFİLİM (ad + profil fotoğrafı)
// ============================================================
let profilSecilenFoto = null;

$("profil-duzenle-btn").addEventListener("click", () => {
  $("profil-ad-input").value = suankiKullanici.ad || "";
  $("profil-dogum-tarihi-input").value = tumUyeler[suankiKullanici.uid]?.dogumTarihi || "";
  $("profil-avatar-onizleme").innerHTML = avatarIcerik(tumUyeler[suankiKullanici.uid]);
  profilSecilenFoto = null;
  goster($("modal-profil"));
});

$("profil-foto-sec-btn").addEventListener("click", () => $("profil-foto-input").click());
$("profil-foto-input").addEventListener("change", async (e) => {
  const dosya = e.target.files[0];
  e.target.value = "";
  if (!dosya) return;
  if (dosya.size > 20 * 1024 * 1024) { alert("Fotoğraf 20MB'tan büyük olamaz."); return; }
  try {
    profilSecilenFoto = await gorseliSikistir(dosya);
  } catch { profilSecilenFoto = dosya; }
  $("profil-avatar-onizleme").innerHTML = `<img src="${URL.createObjectURL(dosya)}" />`;
});

$("profil-kaydet-btn").addEventListener("click", async () => {
  const yeniAd = $("profil-ad-input").value.trim();
  if (!yeniAd) { alert("Ad boş olamaz."); return; }
  const yeniDogumTarihi = $("profil-dogum-tarihi-input").value;

  const guncelleme = { ad: yeniAd };
  if (yeniDogumTarihi) guncelleme.dogumTarihi = yeniDogumTarihi;
  try {
    if (profilSecilenFoto) {
      guncelleme.profilFotoUrl = await cloudinaryYukle(profilSecilenFoto);
    }
    await updateDoc(doc(db, "kullanicilar", suankiKullanici.uid), guncelleme);
    suankiKullanici.ad = yeniAd;
    profilSecilenFoto = null;
    sakla($("modal-profil"));
  } catch (err) {
    alert("Kaydedilemedi: " + err.message);
  }
});

// ============================================================
// HESAP YÖNETİMİ — Şifre / E-posta değiştir / Hesabı sil
// ============================================================

// Yardımcı: Firebase Auth kimlik doğrulama hatalarını Türkçe'ye çevir
function authHataMetni(err) {
  const kod = err?.code || "";
  if (kod.includes("wrong-password") || kod.includes("invalid-credential")) return "Mevcut şifre hatalı.";
  if (kod.includes("weak-password")) return "Yeni şifre çok kısa — en az 6 karakter olmalı.";
  if (kod.includes("email-already-in-use")) return "Bu e-posta zaten başka bir hesapta kullanılıyor.";
  if (kod.includes("invalid-email")) return "Geçerli bir e-posta adresi gir.";
  if (kod.includes("requires-recent-login")) return "Güvenlik nedeniyle tekrar giriş yapman gerekiyor. Çıkış yapıp yeniden giriş yap.";
  if (kod.includes("too-many-requests")) return "Çok fazla deneme. Lütfen birkaç dakika bekle.";
  return err.message || "Bir hata oluştu.";
}

function modalHataGoster(elemanId, metin) {
  const el = $(elemanId);
  el.textContent = metin;
  goster(el);
}
function modalHataTemizle(elemanId) {
  const el = $(elemanId);
  el.textContent = "";
  sakla(el);
}

// ---------- Şifre değiştir ----------
$("sifre-degistir-ac-btn").addEventListener("click", () => {
  $("sifre-mevcut").value = "";
  $("sifre-yeni").value = "";
  $("sifre-yeni-tekrar").value = "";
  modalHataTemizle("sifre-degistir-hata");
  sakla($("modal-profil"));
  goster($("modal-sifre-degistir"));
});

$("sifre-degistir-btn").addEventListener("click", async () => {
  const mevcutSifre = $("sifre-mevcut").value;
  const yeniSifre   = $("sifre-yeni").value;
  const tekrarSifre = $("sifre-yeni-tekrar").value;

  modalHataTemizle("sifre-degistir-hata");

  if (!mevcutSifre || !yeniSifre || !tekrarSifre) {
    modalHataGoster("sifre-degistir-hata", "Tüm alanları doldur."); return;
  }
  if (yeniSifre.length < 6) {
    modalHataGoster("sifre-degistir-hata", "Yeni şifre en az 6 karakter olmalı."); return;
  }
  if (yeniSifre !== tekrarSifre) {
    modalHataGoster("sifre-degistir-hata", "Yeni şifreler birbiriyle eşleşmiyor."); return;
  }

  const btn = $("sifre-degistir-btn");
  btn.disabled = true;
  btn.textContent = "Değiştiriliyor…";
  try {
    const kullanici = auth.currentUser;
    const kimlik = EmailAuthProvider.credential(kullanici.email, mevcutSifre);
    await reauthenticateWithCredential(kullanici, kimlik);
    await updatePassword(kullanici, yeniSifre);
    sakla($("modal-sifre-degistir"));
    setTimeout(() => alert("✅ Şifren başarıyla değiştirildi."), 150);
  } catch (err) {
    modalHataGoster("sifre-degistir-hata", authHataMetni(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Değiştir";
  }
});

// ---------- E-posta değiştir ----------
$("eposta-degistir-ac-btn").addEventListener("click", () => {
  $("eposta-mevcut-goster").textContent = auth.currentUser?.email || "";
  $("eposta-yeni").value = "";
  $("eposta-sifre").value = "";
  modalHataTemizle("eposta-degistir-hata");
  sakla($("modal-profil"));
  goster($("modal-eposta-degistir"));
});

$("eposta-degistir-btn").addEventListener("click", async () => {
  const yeniEposta = $("eposta-yeni").value.trim();
  const sifre      = $("eposta-sifre").value;

  modalHataTemizle("eposta-degistir-hata");

  if (!yeniEposta || !sifre) {
    modalHataGoster("eposta-degistir-hata", "Tüm alanları doldur."); return;
  }

  const btn = $("eposta-degistir-btn");
  btn.disabled = true;
  btn.textContent = "Değiştiriliyor…";
  try {
    const kullanici = auth.currentUser;
    const kimlik = EmailAuthProvider.credential(kullanici.email, sifre);
    await reauthenticateWithCredential(kullanici, kimlik);
    await updateEmail(kullanici, yeniEposta);
    // Firestore'daki eposta alanını da güncelle
    await updateDoc(doc(db, "kullanicilar", kullanici.uid), { eposta: yeniEposta });
    sakla($("modal-eposta-degistir"));
    setTimeout(() => alert("✅ E-posta adresin başarıyla değiştirildi."), 150);
  } catch (err) {
    modalHataGoster("eposta-degistir-hata", authHataMetni(err));
  } finally {
    btn.disabled = false;
    btn.textContent = "Değiştir";
  }
});

// ---------- Hesabı kalıcı olarak sil ----------
$("hesap-sil-ac-btn").addEventListener("click", () => {
  $("hesap-sil-sifre").value = "";
  modalHataTemizle("hesap-sil-hata");
  sakla($("modal-profil"));
  goster($("modal-hesap-sil"));
});

$("hesap-sil-btn").addEventListener("click", async () => {
  const sifre = $("hesap-sil-sifre").value;
  modalHataTemizle("hesap-sil-hata");

  if (!sifre) {
    modalHataGoster("hesap-sil-hata", "Şifreni girmeden hesabını silemezsin."); return;
  }

  const btn = $("hesap-sil-btn");
  btn.disabled = true;
  btn.textContent = "Siliniyor…";
  try {
    const kullanici = auth.currentUser;
    const kimlik = EmailAuthProvider.credential(kullanici.email, sifre);
    await reauthenticateWithCredential(kullanici, kimlik);

    // 1) Kullanıcı profilini Firestore'dan sil
    await deleteDoc(doc(db, "kullanicilar", kullanici.uid));

    // 2) Sohbetlerdeki grup üyeliklerini kaldır
    //    (birebir sohbetler listede kalır ama üye göstergesi "Üye" olarak görünür)
    const grupSohbetler = await getDocs(
      query(collection(db, "sohbetler"),
        where("tip", "==", "grup"),
        where("uyeler", "array-contains", kullanici.uid))
    );
    const cikislar = grupSohbetler.docs.map((d) =>
      updateDoc(d.ref, { uyeler: arrayRemove(kullanici.uid) })
    );
    await Promise.all(cikislar);

    // 3) Firebase Auth'dan hesabı sil (bu oturumu da sonlandırır)
    await deleteUser(kullanici);

    // Auth state değişince uygulama zaten giriş ekranına düşecek
  } catch (err) {
    modalHataGoster("hesap-sil-hata", authHataMetni(err));
    btn.disabled = false;
    btn.textContent = "Hesabı sil";
  }
});

// ============================================================
// EMOJİ SEÇİCİ
// ============================================================
const EMOJI_LISTESI = [
  "😀","😁","😂","🤣","😊","😍","😘","😜","🤔","😎",
  "😴","😢","😭","😡","🥳","🤗","🙏","👍","👎","👏",
  "🙌","💪","✌️","🤝","❤️","🧡","💛","💚","💙","💜",
  "🔥","✨","🎉","🎂","🎁","🌸","☀️","🌙","⭐","🍀",
  "☕","🍎","🍕","🍇","🐶","🐱","🦋","🌹","👋","😇"
];
const emojiPanel = $("emoji-panel");
EMOJI_LISTESI.forEach((e) => {
  const b = document.createElement("button");
  b.className = "emoji-ogesi";
  b.textContent = e;
  b.addEventListener("click", () => {
    girisKutu.value += e;
    girisKutu.dispatchEvent(new Event("input"));
    girisKutu.focus();
  });
  emojiPanel.appendChild(b);
});

$("emoji-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  emojiPanel.classList.toggle("gizli");
  $("ek-menu").classList.add("gizli");
});
document.addEventListener("click", (e) => {
  if (!emojiPanel.contains(e.target) && e.target !== $("emoji-btn") && !$("emoji-btn").contains(e.target)) {
    emojiPanel.classList.add("gizli");
  }
});

// ============================================================
// STATÜS / HİKAYE (24 saat)
// ============================================================
let statuslerCache = [];     // tüm aktif (24 saat içi) statüsler
let statuGoruntulemeListesi = [];
let statuGoruntulemeIndeksi = 0;
let statuOtoIlerletmeId = null;

function statuleriDinle() {
  const yirmiDortSaatOnce = Date.now() - 24 * 60 * 60 * 1000;
  const q = query(
    collection(db, "statusler"),
    where("zamanMs", ">", yirmiDortSaatOnce),
    orderBy("zamanMs", "desc")
  );
  onSnapshot(q, (snap) => {
    statuslerCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    statuSeridiCiz();
  });
}

// ---------- Süresi dolmuş (24 saat+) statüleri veritabanından temizle ----------
// Sunucusuz/ücretsiz kurulumda zamanlanmış bir temizlik fonksiyonu olmadığından,
// herhangi bir aile üyesi uygulamayı her açtığında eski statüsler süpürülür.
// (firestore.rules buna izin verir: 24 saati dolmuş bir statüsü sahibi olmasan da silebilirsin.)
async function eskiStatuleriSupur() {
  try {
    const esikMs = Date.now() - 24 * 60 * 60 * 1000;
    const q = query(collection(db, "statusler"), where("zamanMs", "<=", esikMs), limit(50));
    const snap = await getDocs(q);
    if (snap.empty) return;
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
  } catch (err) {
    console.warn("Eski statüler temizlenemedi:", err.message);
  }
}
// Uygulama açıkken de periyodik olarak süpür (1 saatte bir) — uzun süre açık
// kalan bir cihaz varsa o da diğer üyelerin eski statülerini temizlemiş olur.
setInterval(eskiStatuleriSupur, 60 * 60 * 1000);

function statuSeridiCiz() {
  const serit = $("statu-seridi");
  serit.innerHTML = "";

  // Kendi statüsüm
  const kendiStatuler = statuslerCache.filter((s) => s.uid === suankiKullanici.uid);
  const kendiOge = document.createElement("div");
  kendiOge.className = "statu-ogesi";
  kendiOge.innerHTML = `
    <div class="statu-cerceve ${kendiStatuler.length ? "aktif-halka" : ""}" style="position:relative;">
      <div class="avatar">${avatarIcerik(tumUyeler[suankiKullanici.uid])}</div>
      <div class="statu-ekle-rozet"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg></div>
    </div>
    <div class="etiket">Senin statüsün</div>`;
  kendiOge.addEventListener("click", () => {
    if (kendiStatuler.length) statuGoruntule(kendiStatuler[0].uid);
    else statuEklemodaliniAc();
  });
  serit.appendChild(kendiOge);

  // Diğer üyelerin statüleri (kullanıcı bazında en yeni statü)
  const digerUidler = [...new Set(statuslerCache.filter((s) => s.uid !== suankiKullanici.uid).map((s) => s.uid))];
  digerUidler.forEach((uid) => {
    const veri = tumUyeler[uid] || {};
    const oge = document.createElement("div");
    oge.className = "statu-ogesi";
    oge.innerHTML = `
      <div class="statu-cerceve aktif-halka">
        <div class="avatar">${avatarIcerik(veri)}</div>
      </div>
      <div class="etiket">${kacir(veri.ad || "Üye")}</div>`;
    oge.addEventListener("click", () => statuGoruntule(uid));
    serit.appendChild(oge);
  });
}

function statuEklemodaliniAc() {
  $("statu-metin-input").value = "";
  $("statu-ekle-onizleme").innerHTML = "";
  statuSecilenFoto = null;
  goster($("modal-statu-ekle"));
}

let statuSecilenFoto = null;
$("statu-foto-sec-btn").addEventListener("click", () => $("statu-foto-input").click());
$("statu-foto-input").addEventListener("change", async (e) => {
  const dosya = e.target.files[0];
  e.target.value = "";
  if (!dosya) return;
  try {
    statuSecilenFoto = await gorseliSikistir(dosya);
  } catch { statuSecilenFoto = dosya; }
  $("statu-ekle-onizleme").innerHTML = `<img src="${URL.createObjectURL(statuSecilenFoto)}" style="max-width:100%;border-radius:10px;display:block;" />`;
});

$("statu-paylas-btn").addEventListener("click", async () => {
  const metin = $("statu-metin-input").value.trim();
  if (!statuSecilenFoto && !metin) { alert("Bir fotoğraf seç veya metin yaz."); return; }

  try {
    let medyaUrl = null;
    if (statuSecilenFoto) medyaUrl = await cloudinaryYukle(statuSecilenFoto);

    await addDoc(collection(db, "statusler"), {
      uid: suankiKullanici.uid,
      ad: suankiKullanici.ad,
      medyaUrl,
      metin,
      zaman: serverTimestamp(),
      zamanMs: Date.now(),
      gorenler: []
    });
    sakla($("modal-statu-ekle"));
  } catch (err) {
    alert("Paylaşılamadı: " + err.message);
  }
});

function statuGoruntule(uid) {
  // Bu kullanıcının (en yeni) statüsünü göster; şeritteki kişiler arasında geçiş için sırayı hazırla
  const tumUidSirasi = [
    suankiKullanici.uid,
    ...[...new Set(statuslerCache.filter((s) => s.uid !== suankiKullanici.uid).map((s) => s.uid))]
  ].filter((u) => statuslerCache.some((s) => s.uid === u));

  statuGoruntulemeListesi = tumUidSirasi;
  statuGoruntulemeIndeksi = tumUidSirasi.indexOf(uid);
  if (statuGoruntulemeIndeksi < 0) statuGoruntulemeIndeksi = 0;
  statuGoster();
}

let statuAktifGosterilenStatu = null;

function statuGoster() {
  clearTimeout(statuOtoIlerletmeId);
  const uid = statuGoruntulemeListesi[statuGoruntulemeIndeksi];
  const s = statuslerCache.filter((x) => x.uid === uid).sort((a, b) => (b.zamanMs || 0) - (a.zamanMs || 0))[0];
  if (!s) { statuKapat(); return; }
  statuAktifGosterilenStatu = s;

  const veri = tumUyeler[uid] || { ad: s.ad };
  $("statu-gor-avatar").innerHTML = avatarIcerik(veri);
  $("statu-gor-ad").textContent = uid === suankiKullanici.uid ? "Sen" : (veri.ad || "Üye");
  $("statu-gor-zaman").textContent = s.zaman ? zamanFormatla(s.zaman) : "";

  const icerikEl = $("statu-icerik-alani");
  if (s.medyaUrl) {
    icerikEl.innerHTML = `<img src="${s.medyaUrl}" alt="statüs" />` + (s.metin ? `<div class="statu-metin-tam" style="position:absolute;bottom:0;background:linear-gradient(transparent,rgba(0,0,0,.6));width:100%;padding:16px;font-size:15px;">${kacir(s.metin)}</div>` : "");
  } else {
    icerikEl.innerHTML = `<div class="statu-metin-tam">${kacir(s.metin || "")}</div>`;
  }

  // İlerleme çubuğunu yeniden başlat
  const iz = $("statu-ilerleme-iz");
  iz.style.animation = "none";
  // reflow tetikle
  void iz.offsetWidth;
  iz.style.animation = "";

  if (uid !== suankiKullanici.uid && !(s.gorenler || []).includes(suankiKullanici.uid)) {
    updateDoc(doc(db, "statusler", s.id), { gorenler: arrayUnion(suankiKullanici.uid) }).catch(() => {});
  }

  // Kendi statüne tepki/yanıt verilemez — bunun yerine kaç kişinin gördüğünü göster.
  // Başkasının statüsündeyse tepki/yanıt çubuğu gösterilir.
  $("statu-yanit-input").value = "";
  if (uid === suankiKullanici.uid) {
    sakla($("statu-yanit-cubugu"));
    goster($("statu-kendi-bilgi-cubugu"));
    const goren = (s.gorenler || []).length;
    $("statu-gorenler-sayisi").textContent =
      goren === 0 ? "Henüz kimse görmedi" : goren === 1 ? "1 kişi gördü" : `${goren} kişi gördü`;
  } else {
    goster($("statu-yanit-cubugu"));
    sakla($("statu-kendi-bilgi-cubugu"));
  }

  goster($("statu-goruntuleyici"));
  statuOtoIlerletmeId = setTimeout(statuSonraki, 5000);
}

function statuSonraki() {
  if (statuGoruntulemeIndeksi < statuGoruntulemeListesi.length - 1) {
    statuGoruntulemeIndeksi++;
    statuGoster();
  } else {
    statuKapat();
  }
}
function statuOnceki() {
  if (statuGoruntulemeIndeksi > 0) {
    statuGoruntulemeIndeksi--;
    statuGoster();
  }
}
function statuKapat() {
  clearTimeout(statuOtoIlerletmeId);
  sakla($("statu-goruntuleyici"));
}

$("statu-sonraki").addEventListener("click", statuSonraki);
$("statu-onceki").addEventListener("click", statuOnceki);
$("statu-kapat-btn").addEventListener("click", statuKapat);

// ---------- Statüye yorum/tepki gönderme ----------
// WhatsApp'taki gibi: bir statüye yazılan yanıt ya da basılan tepki emojisi,
// o statüyü paylaşan kişiyle olan birebir sohbete normal bir mesaj olarak
// (statünün küçük bir alıntısıyla birlikte) gönderilir. Kendi statüne
// yanıt/tepki verilemez (çubuk o durumda zaten gizlenir).
function statuOzetUret(s) {
  if (!s) return "";
  if (s.medyaUrl) return s.metin ? s.metin.slice(0, 160) : "📷 Fotoğraf";
  return (s.metin || "").slice(0, 160);
}

async function statuYanitGonder(icerik, tepkiMi = false) {
  const s = statuAktifGosterilenStatu;
  const metin = (icerik || "").trim();
  if (!s || !metin) return;
  if (s.uid === suankiKullanici.uid) return; // kendi statüne yanıt verilmez
  if (!tumUyeler[s.uid]) { alert("Bu kişi artık aile üyesi değil."); return; }

  clearTimeout(statuOtoIlerletmeId); // yanıtlarken statü kendiliğinden ilerlemesin

  try {
    const karsiUid = s.uid;
    const id = birebirSohbetId(suankiKullanici.uid, karsiUid);
    const ref = doc(db, "sohbetler", id);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        tip: "birebir",
        uyeler: [suankiKullanici.uid, karsiUid],
        sonMesaj: "",
        sonMesajZamani: serverTimestamp(),
        olusturulmaZamani: serverTimestamp()
      });
    }

    await addDoc(collection(db, "sohbetler", id, "mesajlar"), {
      gonderenUid: suankiKullanici.uid,
      tip: "metin",
      metin,
      zaman: serverTimestamp(),
      statuYaniti: {
        statuId: s.id,
        medyaUrl: s.medyaUrl || null,
        ozet: statuOzetUret(s)
      }
    });

    const sonMesajMetni = tepkiMi ? `📖 Statüne ${metin} ile tepki verdi` : "📖 Statüne yanıt verdi";
    await updateDoc(ref, {
      sonMesaj: sonMesajMetni,
      sonMesajZamani: serverTimestamp(),
      [`okunmamis.${karsiUid}`]: increment(1),
      [`okunmamis.${suankiKullanici.uid}`]: 0
    });

    pushBildirimGonder(
      [karsiUid],
      `${suankiKullanici.ad || "Bir aile üyesi"} (statü)`,
      tepkiMi ? `Statüne ${metin} ile tepki verdi` : metin,
      "kakule-statu-" + id,
      id
    );
  } catch (err) {
    alert("Gönderilemedi: " + err.message);
  }
}

$("statu-yanit-input")?.addEventListener("focus", () => clearTimeout(statuOtoIlerletmeId));
$("statu-yanit-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    $("statu-yanit-gonder-btn").click();
  }
});

$("statu-yanit-gonder-btn")?.addEventListener("click", async () => {
  const input = $("statu-yanit-input");
  const metin = input.value.trim();
  if (!metin) return;
  input.value = "";
  input.disabled = true;
  await statuYanitGonder(metin, false);
  input.disabled = false;
  input.focus();
  input.placeholder = "Gönderildi ✓";
  setTimeout(() => { input.placeholder = "Yanıt yaz..."; }, 1500);
});

document.querySelectorAll(".statu-tepki-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.style.transform = "scale(1.3)";
    await statuYanitGonder(btn.dataset.emoji, true);
    setTimeout(() => { btn.style.transform = ""; btn.disabled = false; }, 350);
  });
});

// ============================================================
// PUSH BİLDİRİMİ (uygulama tamamen kapalıyken çalışır — Cloudflare Worker üzerinden)
// ============================================================

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

// sessiz=true: uygulama açılışında arka planda çağrılır — SADECE izin daha
// önceden zaten "granted" ise abone olur. Modern tarayıcılar (Chrome/Edge),
// bir kullanıcı tıklaması (gesture) OLMADAN yapılan Notification.requestPermission()
// çağrılarını sessizce yok sayar (izin penceresi hiç açılmaz, izin "default"
// olarak kalır) — bu yüzden burada asla requestPermission çağırmıyoruz.
// sessiz=false: Profil > "Bildirim İzni (Push)" düğmesinden çağrılır (gerçek
// bir tıklama sonucu olduğundan tarayıcı izin penceresini gösterebilir) ve
// sonucu kullanıcıya kısaca özetler.
async function pushAbonelikBaslat(sessiz = true) {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    if (!sessiz) alert("Bu tarayıcı/cihaz push bildirimlerini desteklemiyor.");
    return;
  }
  if (!VAPID_PUBLIC_KEY || VAPID_PUBLIC_KEY.startsWith("BURAYA") || !CF_WORKER_URL || CF_WORKER_URL.startsWith("BURAYA")) {
    if (!sessiz) alert("Bildirim ayarları eksik yapılandırılmış (VAPID/Worker adresi).");
    return;
  }

  try {
    if (Notification.permission === "denied") {
      if (!sessiz) alert("🔔 Bildirim izni kapalı görünüyor. Açmak için tarayıcının/telefonun site ayarlarından bu uygulamaya bildirim izni vermen gerekiyor.");
      return;
    }
    if (Notification.permission === "default") {
      // Sadece gerçek bir tıklama sonucunda (sessiz=false) izin penceresini tetikle.
      if (sessiz) return;
      const izin = await Notification.requestPermission();
      if (izin !== "granted") {
        if (!sessiz) alert("🔔 Bildirim izni verilmedi.");
        return;
      }
    }
    // Buraya geldiysek Notification.permission === "granted"

    const reg = await navigator.serviceWorker.ready;
    let subscription = await reg.pushManager.getSubscription();
    if (!subscription) {
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }

    const subJson = subscription.toJSON();
    const mevcutKayitli = (tumUyeler[suankiKullanici.uid]?.pushSubscriptions || [])
      .some((s) => s.endpoint === subJson.endpoint);
    if (!mevcutKayitli) {
      await updateDoc(doc(db, "kullanicilar", suankiKullanici.uid), {
        pushSubscriptions: arrayUnion(subJson)
      });
    }
    if (!sessiz) alert("🔔 Bildirim izni açık ve bu cihaz kayıtlı. Artık mesaj bildirimleri gelecek.");
  } catch (err) {
    console.warn("Push abonelik kurulamadı:", err.message);
    if (!sessiz) alert("Bildirim aboneliği kurulamadı: " + err.message);
  }
}

$("bildirim-izni-ac-btn")?.addEventListener("click", () => pushAbonelikBaslat(false));

// ============================================================
// KONUM İZNİ (önceden iste — konum gönderme ve SOS anında çalışsın)
// ============================================================
// Mantık: izin tarayıcı/telefon seviyesinde tek seferlik bir şeydir. Bunu
// uygulama açılışında (kullanıcı bir şey göndermeden ÖNCE) isteyip "izin
// verildi" durumuna getirirsek, kullanıcı daha sonra konum gönder'e ya da
// 🆘 SOS'a bastığında tarayıcı izin penceresi ARTIK ÇIKMAZ — konum direkt
// alınır. Ayrıca izin verildiyse arka planda hafif bir konum takibi
// başlatılır (sonBilinenKonum), böylece SOS basıldığı an GPS'in yeni bir
// ölçüm almasını beklemeden en güncel bilinen konum anında gönderilebilir.
let konumIzniDurumu = "bilinmiyor"; // "bilinmiyor" | "granted" | "denied" | "prompt" | "desteklenmiyor"
let sonBilinenKonum = null;         // { lat, lng, zaman }
let konumWatchId = null;

// ----------------------------------------------------------------
// Günlük özet bildirimi (hava durumu) konumun Firestore'da güncel kalması
// için en son bilinen konumu profile yazıyoruz — ama her GPS ölçümünde
// değil (saniyede onlarca yazma olur), sadece belli bir süre geçtiğinde
// (throttle). Cloudflare Worker, her gün 09:00'da bu kayıtlı konumu okuyup
// o günün hava durumunu hesaplar.
// ----------------------------------------------------------------
let sonKonumYazmaZamani = 0;
const KONUM_YAZMA_ARALIGI_MS = 15 * 60 * 1000; // en sık 15 dakikada bir yaz

async function konumuFirestoreyeKaydet(lat, lng) {
  const simdi = Date.now();
  if (simdi - sonKonumYazmaZamani < KONUM_YAZMA_ARALIGI_MS) return;
  sonKonumYazmaZamani = simdi;
  try {
    await updateDoc(doc(db, "kullanicilar", suankiKullanici.uid), {
      sonKonum: { lat, lng, zaman: simdi }
    });
  } catch (err) {
    console.warn("Konum kaydedilemedi:", err.message);
  }
}

function konumTakibiBaslat() {
  if (!navigator.geolocation || !navigator.geolocation.watchPosition) return;
  if (konumWatchId !== null) return; // zaten takip ediliyor
  konumWatchId = navigator.geolocation.watchPosition(
    (pos) => {
      sonBilinenKonum = { lat: pos.coords.latitude, lng: pos.coords.longitude, zaman: Date.now() };
      konumuFirestoreyeKaydet(pos.coords.latitude, pos.coords.longitude);
    },
    () => { /* ölçüm geçici olarak başarısız olabilir, sessizce geç */ },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 15000 }
  );
}

// sessiz=true: uygulama açılışında arka planda çağrılır, kullanıcıya hiçbir
// şey göstermez (tarayıcı zaten kendi izin penceresini gösterir, ekstra
// bizim alert'imize gerek yok). sessiz=false: Profil > Konum İzni
// düğmesinden çağrılır, sonucu kullanıcıya kısaca özetler.
async function konumIzniIste(sessiz = true) {
  if (!navigator.geolocation) {
    konumIzniDurumu = "desteklenmiyor";
    if (!sessiz) alert("Bu tarayıcı/cihaz konum özelliğini desteklemiyor.");
    return;
  }

  try {
    if (navigator.permissions && navigator.permissions.query) {
      const durum = await navigator.permissions.query({ name: "geolocation" });
      konumIzniDurumu = durum.state; // "granted" | "denied" | "prompt"

      if (durum.state === "granted") {
        konumTakibiBaslat();
        if (!sessiz) alert("📍 Konum izni zaten açık. Konum gönderme ve 🆘 SOS, izin penceresi çıkmadan anında çalışacak.");
        return;
      }
      if (durum.state === "denied") {
        if (!sessiz) alert("📍 Konum izni kapalı görünüyor. Açmak için tarayıcının/telefonun site ayarlarından bu uygulamaya konum izni vermen gerekiyor.");
        return;
      }
      // "prompt" — tarayıcı izin penceresini henüz hiç göstermemiş, aşağıda tetikleniyor.
    }

    // Permissions API yoksa (örn. bazı Safari sürümleri) ya da durum "prompt" ise,
    // izin penceresini şimdiden tetikle — kullanıcıyı SOS anına kadar bekletme.
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        konumIzniDurumu = "granted";
        sonBilinenKonum = { lat: pos.coords.latitude, lng: pos.coords.longitude, zaman: Date.now() };
        konumuFirestoreyeKaydet(pos.coords.latitude, pos.coords.longitude);
        konumTakibiBaslat();
        if (!sessiz) alert("📍 Konum izni verildi. Artık konum gönderme ve 🆘 SOS anında çalışacak.");
      },
      () => {
        konumIzniDurumu = "denied";
        if (!sessiz) alert("📍 Konum izni verilmedi. İstersen daha sonra tarayıcı ayarlarından açabilirsin.");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  } catch (err) {
    if (!sessiz) alert("Konum izni kontrol edilemedi: " + err.message);
  }
}

$("konum-izni-ac-btn")?.addEventListener("click", () => konumIzniIste(false));

// Belirtilen kullanıcı uid'lerine (gönderenin kendisi hariç) push bildirimi yolla.
// sohbetId verilirse (ve zorla=false ise), alıcı o sohbeti veya tüm uygulamayı
// sessize almışsa bildirim atlanır. zorla=true ile bu kontrol bypass edilir
// (örn. acil durum / SOS bildirimleri her zaman gider).
async function pushBildirimGonder(aliciUidler, baslik, govde, etiket, sohbetId, zorla = false) {
  if (!CF_WORKER_URL || CF_WORKER_URL.startsWith("BURAYA")) return;
  if (!workerPaylasimAnahtari) return; // henüz yüklenmemiş ya da Firestore'da tanımlı değil

  const url = (location.href.split("#")[0]) || "./";
  for (const uid of aliciUidler) {
    if (uid === suankiKullanici.uid) continue;
    if (!zorla && bildirimSessizMi(uid, sohbetId)) continue;
    const subs = tumUyeler[uid]?.pushSubscriptions || [];
    for (const sub of subs) {
      fetch(CF_WORKER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Paylaşım anahtarını gövde yerine Authorization header'ında yolluyoruz
          // (loglara/proxy'lere sızma riskini azaltır; Worker her ikisini de kabul eder).
          "Authorization": "Bearer " + workerPaylasimAnahtari
        },
        body: JSON.stringify({
          subscription: sub,
          uid, // Worker, gönderim kalıcı olarak başarısız olursa (404/410) bu
               // aboneliği Firestore'dan otomatik temizleyebilsin diye.
          title: baslik,
          body: govde,
          icon: "icons/icon-192.png",
          url,
          tag: etiket || "kakule-mesaj"
        })
      }).catch(() => {}); // bildirim başarısız olsa da mesajlaşmayı etkilemesin
    }
  }
}

// Aktif sohbetteki, gönderen hariç tüm üyelere bildirim gönderir.
// Etiketlenen (bahsedilenler) varsa onlara daha dikkat çekici, ayrı bir başlıkla gönderilir.
function aktifSohbetAlicilarinaBildir(govde, hedefSohbet, bahsedilenler) {
  const s = hedefSohbet || sohbetlerCache.find((x) => x.id === aktifSohbetId);
  const sohbetId = hedefSohbet ? hedefSohbet.id : aktifSohbetId;
  const sohbetTipi = hedefSohbet ? hedefSohbet.tip : aktifSohbetTipi;
  const uyeler = s?.uyeler || (!hedefSohbet && aktifSohbetKarsi ? [aktifSohbetKarsi] : []);
  const etiketliler = bahsedilenler || [];
  const digerleri = uyeler.filter((uid) => !etiketliler.includes(uid));

  const baslik = sohbetTipi === "grup"
    ? `${suankiKullanici.ad} (${s?.ad || "Grup"})`
    : suankiKullanici.ad;
  if (digerleri.length) pushBildirimGonder(digerleri, baslik, govde, sohbetId, sohbetId);

  if (etiketliler.length) {
    const baslikEtiket = `👋 ${suankiKullanici.ad} seni etiketledi${sohbetTipi === "grup" ? ` (${s?.ad || "Grup"})` : ""}`;
    pushBildirimGonder(etiketliler, baslikEtiket, govde, sohbetId, sohbetId);
  }
}

// ============================================================
// BİLDİRİM AYARLARI (ses açık/kapalı, hangi ses, sessize alma)
// ============================================================

// ---------- Genel bildirim ayarları modalı ----------
function bildirimAyarlariDoldur() {
  const veriKendisi = tumUyeler[suankiKullanici.uid] || {};
  const ayar = veriKendisi.bildirimAyarlari || {};
  $("bildirim-ses-acik-girdi").checked = ayar.sesAcik !== false; // varsayılan: açık
  $("uygulama-sessiz-girdi").checked = !!ayar.uygulamaSessiz;
  $("cevrimici-gizle-girdi").checked = !!veriKendisi.gizlilik?.sonGorulmeGizli;
  $("gunluk-ozet-girdi").checked = ayar.gunlukOzetKapali !== true; // varsayılan: açık
  const secim = ayar.sesSecimi || "ting";
  document.querySelectorAll('#ses-secim-listesi input[name="ses-secimi"]').forEach((r) => {
    r.checked = (r.value === secim);
  });
}

$("bildirim-ayarlari-ac-btn").addEventListener("click", () => {
  sakla($("modal-profil"));
  bildirimAyarlariDoldur();
  goster($("modal-bildirim-ayarlari"));
});

document.querySelectorAll(".ses-onizle-btn").forEach((btn) => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    bildirimSesiCal(btn.dataset.ses);
  });
});

$("bildirim-ayarlari-kaydet-btn").addEventListener("click", async () => {
  const sesAcik = $("bildirim-ses-acik-girdi").checked;
  const uygulamaSessiz = $("uygulama-sessiz-girdi").checked;
  const sonGorulmeGizli = $("cevrimici-gizle-girdi").checked;
  const gunlukOzetKapali = !$("gunluk-ozet-girdi").checked;
  const secilen = document.querySelector('#ses-secim-listesi input[name="ses-secimi"]:checked');
  const sesSecimi = secilen ? secilen.value : "ting";

  const btn = $("bildirim-ayarlari-kaydet-btn");
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "kullanicilar", suankiKullanici.uid), {
      bildirimAyarlari: { sesAcik, sesSecimi, uygulamaSessiz, gunlukOzetKapali },
      gizlilik: { sonGorulmeGizli }
    });
    sakla($("modal-bildirim-ayarlari"));
  } catch (err) {
    alert("Kaydedilemedi: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------- Sohbet bazlı sessize alma (kişi / grup) ----------
function aktifSohbetSessizMi() {
  if (!aktifSohbetId) return false;
  const liste = tumUyeler[suankiKullanici.uid]?.sessizeAlinanSohbetler || [];
  return liste.includes(aktifSohbetId);
}

function sohbetSessizDugmesiGuncelle() {
  const btn = $("sohbet-sessiz-btn");
  if (!btn || !aktifSohbetId) return;
  const sessiz = aktifSohbetSessizMi();
  const grupMu = aktifSohbetTipi === "grup";
  btn.classList.toggle("sessiz-aktif", sessiz);
  btn.title = sessiz
    ? (grupMu ? "Grup sohbetini sessize almayı kaldır" : "Kişi sohbetini sessize almayı kaldır")
    : (grupMu ? "Grup sohbetini sessize al" : "Kişi sohbetini sessize al");
  sakla($("sohbet-sessiz-ikon-acik"));
  sakla($("sohbet-sessiz-ikon-kapali"));
  goster(sessiz ? $("sohbet-sessiz-ikon-kapali") : $("sohbet-sessiz-ikon-acik"));
}

$("sohbet-sessiz-btn").addEventListener("click", async () => {
  if (!aktifSohbetId) return;
  const sessiz = aktifSohbetSessizMi();
  const ref = doc(db, "kullanicilar", suankiKullanici.uid);
  try {
    await updateDoc(ref, {
      sessizeAlinanSohbetler: sessiz ? arrayRemove(aktifSohbetId) : arrayUnion(aktifSohbetId)
    });
    // İyimser yerel güncelleme — sunucu yanıtı/onSnapshot'ı beklemeden anında geri bildirim.
    const kendi = tumUyeler[suankiKullanici.uid];
    if (kendi) {
      const mevcut = new Set(kendi.sessizeAlinanSohbetler || []);
      if (sessiz) mevcut.delete(aktifSohbetId); else mevcut.add(aktifSohbetId);
      kendi.sessizeAlinanSohbetler = [...mevcut];
    }
    sohbetSessizDugmesiGuncelle();
  } catch (err) {
    alert("Sessize alma değiştirilemedi: " + err.message);
  }
});

// ============================================================
// ACİL DURUM (SOS)
// ============================================================
const ACIL_VARSAYILAN_MESAJ = "🆘 Acil durumdayım, yardıma ihtiyacım var!";

function acilAyarlariDoldur() {
  const kayitli = tumUyeler[suankiKullanici.uid]?.acilDurum || {};
  $("acil-bilgi-input").value = kayitli.bilgi || "";
  $("acil-mesaj-input").value = kayitli.mesaj || ACIL_VARSAYILAN_MESAJ;

  const liste = $("acil-alici-secim-listesi");
  liste.innerHTML = "";
  const secilenler = new Set(kayitli.aliciUidler || []);
  const digerleri = Object.entries(tumUyeler).filter(([uid]) => uid !== suankiKullanici.uid);

  if (digerleri.length === 0) {
    liste.innerHTML = `<div class="bos-liste">Henüz başka aile üyesi yok.</div>`;
    return;
  }

  digerleri
    .sort((a, b) => (a[1].ad || "").localeCompare(b[1].ad || ""))
    .forEach(([uid, veri]) => {
      const satir = document.createElement("label");
      satir.className = "uye-secim-ogesi";
      satir.innerHTML = `<input type="checkbox" value="${uid}" ${secilenler.has(uid) ? "checked" : ""} /> <div class="avatar" style="width:32px;height:32px;font-size:13px;">${avatarIcerik(veri)}</div> <span class="ad-kutu">${kacir(veri.ad)}</span>`;
      liste.appendChild(satir);
    });
}

$("acil-ayarlar-ac-btn").addEventListener("click", () => {
  sakla($("modal-profil"));
  acilAyarlariDoldur();
  goster($("modal-acil-ayarlar"));
});

$("acil-ayarlar-kaydet-btn").addEventListener("click", async () => {
  const bilgi = $("acil-bilgi-input").value.trim().slice(0, 1000);
  const mesaj = $("acil-mesaj-input").value.trim().slice(0, 300) || ACIL_VARSAYILAN_MESAJ;
  const aliciUidler = [...document.querySelectorAll('#acil-alici-secim-listesi input:checked')].map((i) => i.value);

  if (aliciUidler.length === 0) {
    alert("En az 1 kişi seçmelisin — acil durumda mesajın kime gitsin?");
    return;
  }

  const btn = $("acil-ayarlar-kaydet-btn");
  btn.disabled = true;
  try {
    await updateDoc(doc(db, "kullanicilar", suankiKullanici.uid), {
      acilDurum: { bilgi, mesaj, aliciUidler }
    });
    sakla($("modal-acil-ayarlar"));
  } catch (err) {
    alert("Kaydedilemedi: " + err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---------- SOS butonu: onay iste ----------
$("sos-btn").addEventListener("click", () => {
  const ayar = tumUyeler[suankiKullanici.uid]?.acilDurum;
  if (!ayar || !ayar.aliciUidler || ayar.aliciUidler.length === 0) {
    alert("Önce Acil Durum Ayarları'ndan mesajın kime gönderileceğini seçmelisin.");
    acilAyarlariDoldur();
    goster($("modal-acil-ayarlar"));
    return;
  }

  const alicilar = ayar.aliciUidler
    .filter((uid) => tumUyeler[uid])
    .map((uid) => tumUyeler[uid].ad || "Aile üyesi");

  if (alicilar.length === 0) {
    alert("Seçtiğin kişiler artık aile üyesi değil. Lütfen Acil Durum Ayarları'nı güncelle.");
    acilAyarlariDoldur();
    goster($("modal-acil-ayarlar"));
    return;
  }

  $("acil-onay-icerik").innerHTML = `
    <p style="font-size:13.5px;line-height:1.6;color:var(--metin-soluk);">
      Aşağıdaki <strong style="color:var(--metin);">${alicilar.length} kişiye</strong> acil durum mesajın
      ve anlık konumun gönderilecek:
    </p>
    <p style="font-size:13.5px;margin:8px 0 14px;color:var(--metin);">${alicilar.map(kacir).join(", ")}</p>
    <div class="acil-bilgi-kutu">${kacir(ayar.mesaj)}</div>
  `;
  const gonderBtn = $("acil-onay-gonder-btn");
  gonderBtn.disabled = false;
  gonderBtn.textContent = "Evet, Gönder";
  goster($("modal-acil-onay"));
});

// ---------- SOS onayı: konum al + mesajları gönder ----------
$("acil-onay-gonder-btn").addEventListener("click", async () => {
  const ayar = tumUyeler[suankiKullanici.uid]?.acilDurum;
  if (!ayar || !ayar.aliciUidler?.length) { sakla($("modal-acil-onay")); return; }

  const btn = $("acil-onay-gonder-btn");
  btn.disabled = true;

  // İzin daha önceden verilmiş ve arka plan konum takibi açıksa, en son
  // bilinen konum (sonBilinenKonum) hazırda bekliyordur — tarayıcının yeni
  // bir GPS ölçümü almasını/izin penceresini beklemeden anında kullanılır.
  if (sonBilinenKonum) {
    btn.textContent = "Gönderiliyor...";
    await acilDurumGonder(ayar, sonBilinenKonum);
    return;
  }

  btn.textContent = "Konum alınıyor...";

  if (!navigator.geolocation) {
    btn.textContent = "Gönderiliyor...";
    await acilDurumGonder(ayar, null);
    return;
  }

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      btn.textContent = "Gönderiliyor...";
      await acilDurumGonder(ayar, { lat: pos.coords.latitude, lng: pos.coords.longitude });
    },
    async () => {
      btn.textContent = "Gönderiliyor...";
      await acilDurumGonder(ayar, null);
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
});

async function acilDurumGonder(ayar, konum) {
  const baslik = `🆘 ACİL DURUM — ${suankiKullanici.ad}`;
  const metinIcerik = `🆘 ACİL DURUM\n${ayar.mesaj}${ayar.bilgi ? `\n\nAcil durum bilgisi: ${ayar.bilgi}` : ""}`;
  let basarili = 0;

  for (const karsiUid of ayar.aliciUidler) {
    if (karsiUid === suankiKullanici.uid || !tumUyeler[karsiUid]) continue;
    try {
      const id = birebirSohbetId(suankiKullanici.uid, karsiUid);
      const ref = doc(db, "sohbetler", id);
      const snap = await getDoc(ref);
      if (!snap.exists()) {
        await setDoc(ref, {
          tip: "birebir",
          uyeler: [suankiKullanici.uid, karsiUid],
          sonMesaj: "",
          sonMesajZamani: serverTimestamp(),
          olusturulmaZamani: serverTimestamp()
        });
      }

      await addDoc(collection(db, "sohbetler", id, "mesajlar"), {
        gonderenUid: suankiKullanici.uid,
        tip: "metin",
        metin: metinIcerik,
        zaman: serverTimestamp()
      });

      if (konum) {
        await addDoc(collection(db, "sohbetler", id, "mesajlar"), {
          gonderenUid: suankiKullanici.uid,
          tip: "konum",
          lat: konum.lat, lng: konum.lng,
          metin: "📍 Anlık konum",
          zaman: serverTimestamp()
        });
      }

      await updateDoc(ref, {
        sonMesaj: "🆘 Acil durum bildirimi",
        sonMesajZamani: serverTimestamp(),
        [`okunmamis.${karsiUid}`]: increment(konum ? 2 : 1),
        [`okunmamis.${suankiKullanici.uid}`]: 0
      });

      pushBildirimGonder([karsiUid], baslik, ayar.mesaj, "kakule-acil-" + id, null, true);
      basarili++;
    } catch (err) {
      console.warn("Acil durum mesajı gönderilemedi:", karsiUid, err.message);
    }
  }

  sakla($("modal-acil-onay"));
  sohbetListesiCiz();
  if (basarili > 0) {
    alert(`🆘 Acil durum bildirimi ${basarili} kişiye gönderildi.${konum ? "" : "\n(Konum alınamadı, sadece mesaj gönderildi.)"}`);
  } else {
    alert("Acil durum bildirimi gönderilemedi. İnternet bağlantını kontrol et.");
  }
}

// ============================================================
// ADMİN PANELİ
// ============================================================

function adminButonuGuncelle() {
  const btn = $("admin-panel-btn");
  const dropdownOge = $("ust-menu-admin");
  const admin = suankiKullanici?.rol === "admin";
  if (btn) {
    if (admin) btn.classList.remove("gizli");
    else btn.classList.add("gizli");
  }
  if (dropdownOge) {
    if (admin) dropdownOge.classList.remove("gizli");
    else dropdownOge.classList.add("gizli");
  }
}

$("admin-panel-btn")?.addEventListener("click", () => {
  adminPaneliAc();
});

async function adminPaneliAc() {
  goster($("modal-admin"));
  adminSekmeGec("uyeler");
}

function adminSekmeGec(sekme) {
  ["uyeler", "davetler"].forEach((s) => {
    const btn = $(`admin-sekme-${s}`);
    const alan = $(`admin-alan-${s}`);
    if (s === sekme) {
      btn?.classList.add("aktif");
      alan?.classList.remove("gizli");
    } else {
      btn?.classList.remove("aktif");
      alan?.classList.add("gizli");
    }
  });
  if (sekme === "uyeler") adminUyelerCiz();
  if (sekme === "davetler") adminDavetlerCiz();
}

$("admin-sekme-uyeler")?.addEventListener("click", () => adminSekmeGec("uyeler"));
$("admin-sekme-davetler")?.addEventListener("click", () => adminSekmeGec("davetler"));

// ---------- Üye listesi ----------
async function adminUyelerCiz() {
  const kapsayici = $("admin-uyeler-listesi");
  if (!kapsayici) return;
  kapsayici.innerHTML = `<div style="color:var(--metin-soluk);font-size:13px;padding:12px 0;">Yükleniyor…</div>`;

  const snap = await getDocs(collection(db, "kullanicilar"));
  const uyeler = [];
  snap.forEach((d) => uyeler.push({ uid: d.id, ...d.data() }));
  uyeler.sort((a, b) => (a.ad || "").localeCompare(b.ad || ""));

  kapsayici.innerHTML = "";
  uyeler.forEach((u) => {
    const benMi = u.uid === suankiKullanici.uid;
    const dondurulmus = u.dondurulmus === true;
    const adminMi = u.rol === "admin";

    const oge = document.createElement("div");
    oge.className = "admin-uye-satir";
    oge.innerHTML = `
      <div class="avatar" style="width:42px;height:42px;font-size:16px;flex-shrink:0;">${avatarIcerik(u)}</div>
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:14px;">${kacir(u.ad)}${adminMi ? ' <span style="font-size:11px;background:var(--vurgu);color:#fff;border-radius:4px;padding:1px 5px;">admin</span>' : ""}${benMi ? ' <span style="font-size:11px;color:var(--metin-soluk);">(sen)</span>' : ""}</div>
        <div style="font-size:12px;color:var(--metin-soluk);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${kacir(u.eposta || "")}</div>
        <div style="font-size:11px;color:var(--metin-soluk);margin-top:2px;">
          ${u.cevrimici ? '<span style="color:#4ade80;">● Çevrimiçi</span>' : "Son görülme: " + (u.sonGorulme ? zamanFormatla(u.sonGorulme) : "—")}
          ${u.gizlilik?.sonGorulmeGizli ? ' · <span title="Bu bilgi diğer üyelerden gizlenmiş, sadece sen (admin) görüyorsun.">🙈 gizli</span>' : ""}
          ${dondurulmus ? ' · <span style="color:#E5484D;">🔒 Dondurulmuş</span>' : ""}
        </div>
      </div>
      ${!benMi ? `
      <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
        <button class="btn-ikincil" style="font-size:12px;padding:4px 10px;width:auto;"
          onclick="adminRolToggle('${u.uid}', '${kacir(u.ad)}', ${adminMi})">
          ${adminMi ? "👤 Admin'likten Al" : "⭐ Admin Yap"}
        </button>
        <button class="btn-ikincil" style="font-size:12px;padding:4px 10px;width:auto;"
          onclick="adminDondurToggle('${u.uid}', ${dondurulmus})">
          ${dondurulmus ? "🔓 Aktif Et" : "🔒 Dondur"}
        </button>
        <button class="btn-ikincil" style="font-size:12px;padding:4px 10px;width:auto;color:#E5484D;"
          onclick="adminUyeCikar('${u.uid}', '${kacir(u.ad)}')">
          Çıkar
        </button>
      </div>` : ""}`;
    kapsayici.appendChild(oge);
  });
}

window.adminRolToggle = async function(uid, ad, suankiAdminMi) {
  const yeniRol = suankiAdminMi ? "uye" : "admin";
  const soru = suankiAdminMi
    ? `"${ad}" adlı kişinin admin yetkisini kaldırmak istediğine emin misin?`
    : `"${ad}" adlı kişiyi admin yapmak istediğine emin misin? Admin, üyeleri dondurabilir/çıkarabilir ve başkalarını admin yapabilir.`;
  if (!confirm(soru)) return;
  try {
    await updateDoc(doc(db, "kullanicilar", uid), { rol: yeniRol });
    adminUyelerCiz();
  } catch (err) {
    alert("Hata: " + err.message);
  }
};

window.adminDondurToggle = async function(uid, suankiDurum) {
  try {
    await updateDoc(doc(db, "kullanicilar", uid), { dondurulmus: !suankiDurum });
    adminUyelerCiz();
  } catch (err) {
    alert("Hata: " + err.message);
  }
};

window.adminUyeCikar = async function(uid, ad) {
  if (!confirm(`"${ad}" adlı üyeyi sistemden çıkarmak istediğine emin misin?\nFirestore verisi silinecek; hesap yeniden erişim sağlayamayacak.`)) return;
  try {
    await deleteDoc(doc(db, "kullanicilar", uid));
    adminUyelerCiz();
  } catch (err) {
    alert("Hata: " + err.message);
  }
};

// ---------- Davetler listesi ----------
async function adminDavetlerCiz() {
  const kapsayici = $("admin-davetler-listesi");
  if (!kapsayici) return;
  kapsayici.innerHTML = `<div style="color:var(--metin-soluk);font-size:13px;padding:12px 0;">Yükleniyor…</div>`;

  const snap = await getDocs(collection(db, "davetler"));
  const simdi = Date.now();
  const davetler = [];
  snap.forEach((d) => davetler.push({ id: d.id, ...d.data() }));

  // En yeni önce
  davetler.sort((a, b) => (b.expiresAt || 0) - (a.expiresAt || 0));

  const bekleyenler = davetler.filter((d) => !d.kullanildi && (!d.expiresAt || simdi < d.expiresAt));
  const kullanilanlar = davetler.filter((d) => d.kullanildi);
  const sureDolmus = davetler.filter((d) => !d.kullanildi && d.expiresAt && simdi >= d.expiresAt);

  kapsayici.innerHTML = "";

  function satirEkle(d, etiket, renk) {
    const kalan = d.expiresAt ? Math.max(0, Math.ceil((d.expiresAt - simdi) / 3600000)) : null;
    const oge = document.createElement("div");
    oge.className = "admin-uye-satir";
    oge.style.alignItems = "center";
    oge.innerHTML = `
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;letter-spacing:2px;font-size:15px;">${kacir(d.kod || d.id)}</div>
        <div style="font-size:12px;color:var(--metin-soluk);">Oluşturan: ${kacir(d.olusturanAd || "—")}</div>
        ${d.kullananAd ? `<div style="font-size:12px;color:var(--metin-soluk);">Kullanan: ${kacir(d.kullananAd)}</div>` : ""}
        ${kalan !== null && !d.kullanildi && simdi < (d.expiresAt || 0) ? `<div style="font-size:11px;color:var(--metin-soluk);">${kalan} saat kaldı</div>` : ""}
      </div>
      <span style="font-size:11px;color:${renk};font-weight:600;flex-shrink:0;">${etiket}</span>
      ${!d.kullanildi ? `<button class="btn-ikincil" style="font-size:12px;padding:4px 8px;width:auto;color:#E5484D;flex-shrink:0;"
        onclick="adminDavetSil('${d.id}')">Sil</button>` : ""}`;
    kapsayici.appendChild(oge);
  }

  if (bekleyenler.length) {
    const baslik = document.createElement("div");
    baslik.style.cssText = "font-size:12px;color:var(--metin-soluk);font-weight:600;margin:8px 0 4px;";
    baslik.textContent = `Bekleyen (${bekleyenler.length})`;
    kapsayici.appendChild(baslik);
    bekleyenler.forEach((d) => satirEkle(d, "⏳ Bekliyor", "#4ade80"));
  }

  if (sureDolmus.length) {
    const baslik = document.createElement("div");
    baslik.style.cssText = "font-size:12px;color:var(--metin-soluk);font-weight:600;margin:12px 0 4px;";
    baslik.textContent = `Süresi Dolmuş (${sureDolmus.length})`;
    kapsayici.appendChild(baslik);
    sureDolmus.forEach((d) => satirEkle(d, "❌ Süresi doldu", "#E5484D"));
  }

  if (kullanilanlar.length) {
    const baslik = document.createElement("div");
    baslik.style.cssText = "font-size:12px;color:var(--metin-soluk);font-weight:600;margin:12px 0 4px;";
    baslik.textContent = `Kullanılmış (${kullanilanlar.length})`;
    kapsayici.appendChild(baslik);
    kullanilanlar.forEach((d) => satirEkle(d, "✓ Kullanıldı", "var(--metin-soluk)"));
  }

  if (!davetler.length) {
    kapsayici.innerHTML = `<div style="color:var(--metin-soluk);font-size:13px;padding:12px 0;">Henüz hiç davetiye oluşturulmamış.</div>`;
  }
}

window.adminDavetSil = async function(id) {
  if (!confirm("Bu davetiyeyi silmek istiyor musun?")) return;
  try {
    await deleteDoc(doc(db, "davetler", id));
    adminDavetlerCiz();
  } catch (err) {
    alert("Hata: " + err.message);
  }
};

// Davetler sekmesinden de yeni kod üretebilsin
$("admin-yeni-davet-btn")?.addEventListener("click", async () => {
  const kod = rastgeleKod(8);
  const bitis = Date.now() + 48 * 60 * 60 * 1000;
  await setDoc(doc(db, "davetler", kod), {
    kod,
    olusturanUid: suankiKullanici.uid,
    olusturanAd: suankiKullanici.ad,
    kullanildi: false,
    olusturulmaZamani: serverTimestamp(),
    expiresAt: bitis
  });
  const sayfaUrl = location.href.split("?")[0].split("#")[0];
  const davetLink = `${sayfaUrl}?d=${kod}`;
  const cikti = $("admin-davet-uretilen");
  if (cikti) {
    cikti.innerHTML = `
      <div class="davet-kod-kutusu" style="margin-top:12px;">
        <div class="kod">${kod}</div>
        <div class="aciklama">48 saat geçerli. Bağlantıyı kopyalayıp gönder.</div>
        <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn-ikincil" onclick="navigator.clipboard.writeText('${davetLink}').then(()=>{this.textContent='✓ Kopyalandı';setTimeout(()=>{this.textContent='🔗 Bağlantıyı kopyala'},2000)})">🔗 Bağlantıyı kopyala</button>
          <button class="btn-ikincil" onclick="navigator.clipboard.writeText('${kod}').then(()=>{this.textContent='✓ Kopyalandı';setTimeout(()=>{this.textContent='📋 Sadece kodu kopyala'},2000)})">📋 Sadece kodu kopyala</button>
        </div>
      </div>`;
    cikti.classList.remove("gizli");
  }
  adminDavetlerCiz();
});

// ============================================================
// HOŞ GELDİN ONBOARDING
// ============================================================

const ONBOARDING_SLAYTLAR = [
  {
    svg: `<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="60" cy="60" r="54" fill="var(--vurgu)" opacity="0.12"/>
      <path d="M32 48c0-11 7.5-20 16-20s16 9 16 20c0 4.5-1.2 8.5-3.2 11.5L75 85H45L34.8 59C33 56 32 52.2 32 48z" fill="var(--vurgu)" opacity="0.5"/>
      <path d="M44 75h32l4 10H40l4-10z" fill="var(--vurgu)" opacity="0.7"/>
      <circle cx="60" cy="46" r="6" fill="var(--vurgu)"/>
      <path d="M52 58h16" stroke="var(--vurgu)" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M50 64h20" stroke="var(--vurgu)" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="84" cy="36" r="10" fill="var(--vurgu)" opacity="0.2"/>
      <text x="84" y="41" text-anchor="middle" font-size="12" fill="var(--vurgu)">👋</text>
    </svg>`,
    baslik: "Ailenize Hoş Geldiniz!",
    aciklama: "Kakule, sadece ailenize özel kapalı bir sohbet uygulaması. Davetiye kodu olmadan kimse giremez — sadece siz varsınız burada."
  },
  {
    svg: `<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="60" cy="60" r="54" fill="var(--vurgu)" opacity="0.1"/>
      <rect x="20" y="35" width="55" height="38" rx="10" fill="var(--vurgu)" opacity="0.25"/>
      <rect x="20" y="35" width="55" height="38" rx="10" stroke="var(--vurgu)" stroke-width="2"/>
      <path d="M20 55l27.5 14L75 55" stroke="var(--vurgu)" stroke-width="2" stroke-linecap="round"/>
      <rect x="65" y="52" width="38" height="30" rx="8" fill="var(--vurgu)" opacity="0.18"/>
      <rect x="65" y="52" width="38" height="30" rx="8" stroke="var(--vurgu)" stroke-width="2"/>
      <circle cx="73" cy="62" r="2.5" fill="var(--vurgu)"/>
      <circle cx="81" cy="62" r="2.5" fill="var(--vurgu)"/>
      <circle cx="89" cy="62" r="2.5" fill="var(--vurgu)"/>
      <path d="M69 72h26" stroke="var(--vurgu)" stroke-width="2" stroke-linecap="round"/>
    </svg>`,
    baslik: "Birebir & Grup Sohbeti",
    aciklama: "Aile üyeleriyle birebir mesajlaşın ya da herkesin dahil olduğu grup sohbetleri oluşturun. Fotoğraf, dosya, konum ve sesli mesaj gönderin."
  },
  {
    svg: `<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="60" cy="60" r="54" fill="var(--vurgu)" opacity="0.1"/>
      <circle cx="60" cy="52" r="22" stroke="var(--vurgu)" stroke-width="2.5" stroke-dasharray="5 3"/>
      <circle cx="60" cy="52" r="14" fill="var(--vurgu)" opacity="0.25"/>
      <path d="M53 52c0-3.9 3.1-7 7-7s7 3.1 7 7-3.1 7-7 7" stroke="var(--vurgu)" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="60" cy="52" r="3" fill="var(--vurgu)"/>
      <path d="M36 82c0-6.6 10.7-12 24-12s24 5.4 24 12" stroke="var(--vurgu)" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M82 45l6-4M38 45l-6-4M60 30v-7" stroke="var(--vurgu)" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
    </svg>`,
    baslik: "Statüs & Hikayeler",
    aciklama: "Günlük anınızı fotoğraf veya metin olarak paylaşın. Statüsler 24 saat sonra otomatik kaybolur — Instagram gibi ama sadece ailenize özel."
  },
  {
    svg: `<svg viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="60" cy="60" r="54" fill="var(--vurgu)" opacity="0.1"/>
      <rect x="35" y="25" width="50" height="70" rx="10" stroke="var(--vurgu)" stroke-width="2.5"/>
      <rect x="42" y="33" width="36" height="48" rx="5" fill="var(--vurgu)" opacity="0.15"/>
      <circle cx="60" cy="88" r="3" fill="var(--vurgu)" opacity="0.5"/>
      <path d="M48 50l8 8 16-16" stroke="var(--vurgu)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M50 65h20M50 72h14" stroke="var(--vurgu)" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
      <circle cx="82" cy="32" r="10" fill="var(--vurgu)"/>
      <text x="82" y="37" text-anchor="middle" font-size="13" fill="white">🔔</text>
    </svg>`,
    baslik: "Bildirimler & Giriş",
    aciklama: "Uygulama kapalıyken bile mesaj bildirimlerini alabilirsiniz. Telefon değiştirseniz veya uygulamayı silseniz de aynı e-posta ve şifreyle giriş yaparak her şeye geri kavuşursunuz."
  }
];

let onboardingAktifSlayt = 0;

async function onboardingKontrolEt() {
  try {
    const snap = await getDoc(doc(db, "kullanicilar", suankiKullanici.uid));
    const veri = snap.exists() ? snap.data() : {};
    if (veri.onboardingTamamlandi === false) {
      onboardingGoster();
    }
  } catch (e) {
    // sessizce geç
  }
}

function onboardingGoster() {
  onboardingAktifSlayt = 0;
  onboardingSlaytCiz();
  goster($("onboarding-overlay"));
}

function onboardingSlaytCiz() {
  const s = ONBOARDING_SLAYTLAR[onboardingAktifSlayt];
  const son = onboardingAktifSlayt === ONBOARDING_SLAYTLAR.length - 1;

  $("onboarding-svg").innerHTML = s.svg;
  $("onboarding-baslik").textContent = s.baslik;
  $("onboarding-aciklama").textContent = s.aciklama;
  $("onboarding-ileri-btn").textContent = son ? "Başla 🎉" : "İleri →";

  // Nokta göstergeleri
  const noktalar = $("onboarding-noktalar");
  noktalar.innerHTML = "";
  ONBOARDING_SLAYTLAR.forEach((_, i) => {
    const n = document.createElement("div");
    n.className = "onboarding-nokta" + (i === onboardingAktifSlayt ? " aktif" : "");
    n.addEventListener("click", () => { onboardingAktifSlayt = i; onboardingSlaytCiz(); });
    noktalar.appendChild(n);
  });

  $("onboarding-geri-btn").style.visibility = onboardingAktifSlayt === 0 ? "hidden" : "visible";
}

$("onboarding-ileri-btn")?.addEventListener("click", () => {
  if (onboardingAktifSlayt < ONBOARDING_SLAYTLAR.length - 1) {
    onboardingAktifSlayt++;
    onboardingSlaytCiz();
  } else {
    onboardingTamamla();
  }
});

$("onboarding-geri-btn")?.addEventListener("click", () => {
  if (onboardingAktifSlayt > 0) {
    onboardingAktifSlayt--;
    onboardingSlaytCiz();
  }
});

$("onboarding-atla-btn")?.addEventListener("click", () => {
  onboardingTamamla();
});

async function onboardingTamamla() {
  sakla($("onboarding-overlay"));
  try {
    await updateDoc(doc(db, "kullanicilar", suankiKullanici.uid), {
      onboardingTamamlandi: true
    });
  } catch (e) {}
}

// ============================================================
// YEDEKLEME VE GERİ YÜKLEME
// ============================================================
// Üyesi olunan tüm sohbetleri + mesajları + ilgili profilleri toplar, medyayı
// (isteğe bağlı) indirir ve tek bir .zip olarak cihaza kaydeder. Geri yükleme
// tarafı bu .zip'i salt-okunur bir arşiv görüntüleyicide açar. Sohbetler zaten
// Firestore'da bulutta durduğundan yeni cihazda giriş yapmak geçmişi otomatik
// getirir; bu görüntüleyici, elde tutulan/arşivlenen bir kopyayı okumak içindir.
//
// NOT: Bu yedek ŞİFRESİZDİR — dosya, aile sohbetlerinin tamamını düz metin ve
// açık medya olarak içerir. Drive'a/e-postaya koyarken bu hesaba erişen herkesin
// okuyabileceğini unutma. (İleride parola koruması eklemek için tek nokta:
// yedekPaketiUret çıktısını AES-GCM ile sarmalamak yeterli.)

const YEDEK_SURUM = 1;
let jszipYukleniyor = null;

// JSZip'i CDN'den bir kez, ihtiyaç anında yükler.
function jszipYukle() {
  if (window.JSZip) return Promise.resolve(window.JSZip);
  if (jszipYukleniyor) return jszipYukleniyor;
  jszipYukleniyor = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = () => resolve(window.JSZip);
    s.onerror = () => reject(new Error("JSZip yüklenemedi (internet gerekli)."));
    document.head.appendChild(s);
  });
  return jszipYukleniyor;
}

function yedekIlerleme(yuzde, metin) {
  goster($("yedek-ilerleme"));
  $("yedek-ilerleme-cubuk").style.width = Math.max(0, Math.min(100, yuzde)) + "%";
  if (metin) $("yedek-ilerleme-metin").textContent = metin;
}

// Firestore Timestamp / Date / sayı -> ISO string (JSON'a güvenli yazmak için).
function zamaniSerilestir(z) {
  try {
    if (!z) return null;
    if (z.toDate) return z.toDate().toISOString();
    if (z instanceof Date) return z.toISOString();
    if (typeof z === "number") return new Date(z).toISOString();
    if (typeof z === "string") return z;
  } catch {}
  return null;
}

// Bir medya URL'sini indirip { klasordekiAd, blob } döndürür; başarısızsa null.
async function medyayiCek(url, hedefAd) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("indirilemedi");
    const blob = await res.blob();
    return { ad: hedefAd, blob };
  } catch {
    return null;
  }
}

// URL'den dosya uzantısı tahmini (yoksa boş).
function urldenUzanti(url) {
  try {
    const yol = new URL(url).pathname;
    const nokta = yol.lastIndexOf(".");
    if (nokta > -1 && nokta > yol.lastIndexOf("/")) return yol.slice(nokta);
  } catch {}
  return "";
}

// Ana yedek üretici. medyaDahil=true ise medya dosyaları da zip'e gömülür.
async function yedekPaketiUret(medyaDahil) {
  const JSZip = await jszipYukle();
  const zip = new JSZip();

  yedekIlerleme(4, "Sohbetler toplanıyor…");

  // 1) Üyesi olduğum sohbetler
  const sohbetSnap = await getDocs(
    query(collection(db, "sohbetler"), where("uyeler", "array-contains", suankiKullanici.uid))
  );
  const sohbetler = sohbetSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // 2) İlgili tüm kullanıcı profillerini topla (isim/avatar için)
  const uidKumesi = new Set();
  sohbetler.forEach((s) => (s.uyeler || []).forEach((u) => uidKumesi.add(u)));
  uidKumesi.add(suankiKullanici.uid);

  const profiller = {};
  await Promise.all([...uidKumesi].map(async (uid) => {
    try {
      const ps = await getDoc(doc(db, "kullanicilar", uid));
      if (ps.exists()) {
        const p = ps.data();
        profiller[uid] = { ad: p.ad || "Üye", profilFotoUrl: p.profilFotoUrl || null };
      }
    } catch {}
  }));

  const medyaGorevleri = []; // { url, ad }
  const disaSohbetler = [];

  // 3) Her sohbetin mesajlarını çek
  for (let i = 0; i < sohbetler.length; i++) {
    const s = sohbetler[i];
    yedekIlerleme(8 + Math.round((i / Math.max(1, sohbetler.length)) * 40),
      `Mesajlar toplanıyor (${i + 1}/${sohbetler.length})…`);

    const mesajSnap = await getDocs(
      query(collection(db, "sohbetler", s.id, "mesajlar"), orderBy("zaman", "asc"))
    );

    const mesajlar = mesajSnap.docs.map((d) => {
      const m = { id: d.id, ...d.data() };
      const cikti = {
        id: m.id,
        gonderenUid: m.gonderenUid || null,
        tip: m.tip || "metin",
        metin: m.silindi ? null : (m.metin || null),
        silindi: !!m.silindi,
        duzenlendi: !!m.duzenlendi,
        iletildi: !!m.iletildi,
        zaman: zamaniSerilestir(m.zaman)
      };
      if (m.tip === "konum") { cikti.lat = m.lat; cikti.lng = m.lng; }
      if (m.tip === "dogumgunu") { cikti.dogumGunuAd = m.dogumGunuAd || null; }

      // Medya alanları
      if (m.dosyaUrl && !m.silindi) {
        cikti.dosyaAd = m.dosyaAd || null;
        cikti.orijinalUrl = m.dosyaUrl;
        if (m.tip === "ses") cikti.sureSn = m.sureSn || 0;
        if (medyaDahil) {
          const uzanti = urldenUzanti(m.dosyaUrl) || (m.tip === "gorsel" ? ".jpg" : m.tip === "ses" ? ".webm" : "");
          const yerelAd = `medya/${s.id}/${m.id}${uzanti}`;
          cikti.yerelMedya = yerelAd;
          medyaGorevleri.push({ url: m.dosyaUrl, ad: yerelAd });
        }
      }
      return cikti;
    });

    disaSohbetler.push({
      id: s.id,
      tip: s.tip || "birebir",
      ad: s.ad || null,
      uyeler: s.uyeler || [],
      olusturanUid: s.olusturanUid || null,
      sonMesaj: s.sonMesaj || "",
      sonMesajZamani: zamaniSerilestir(s.sonMesajZamani),
      mesajlar
    });
  }

  // 4) Medyayı indir (isteğe bağlı)
  if (medyaDahil && medyaGorevleri.length) {
    let tamam = 0;
    // 4'erli gruplar halinde indir (tarayıcıyı boğmadan)
    for (let i = 0; i < medyaGorevleri.length; i += 4) {
      const grup = medyaGorevleri.slice(i, i + 4);
      const sonuclar = await Promise.all(grup.map((g) => medyayiCek(g.url, g.ad)));
      sonuclar.forEach((r) => { if (r) zip.file(r.ad, r.blob); });
      tamam += grup.length;
      yedekIlerleme(50 + Math.round((tamam / medyaGorevleri.length) * 42),
        `Medya indiriliyor (${Math.min(tamam, medyaGorevleri.length)}/${medyaGorevleri.length})…`);
    }
  }

  // 5) Manifest + veri JSON'u
  const manifest = {
    uygulama: "Kakule",
    yedekSurum: YEDEK_SURUM,
    olusturma: new Date().toISOString(),
    sahipUid: suankiKullanici.uid,
    sahipAd: suankiKullanici.ad || null,
    medyaDahil: !!medyaDahil,
    sohbetSayisi: disaSohbetler.length,
    mesajSayisi: disaSohbetler.reduce((t, s) => t + s.mesajlar.length, 0)
  };

  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("veri.json", JSON.stringify({ profiller, sohbetler: disaSohbetler }, null, 2));
  // İnsan-okur bir özet de ekleyelim (zip'i açan biri hızlıca görsün).
  zip.file("OKUBENI.txt",
    `Kakule Yedeği\n=============\nOluşturma: ${manifest.olusturma}\nSahip: ${manifest.sahipAd || manifest.sahipUid}\n` +
    `Sohbet: ${manifest.sohbetSayisi}  Mesaj: ${manifest.mesajSayisi}\nMedya dahil: ${manifest.medyaDahil ? "evet" : "hayır"}\n\n` +
    `Bu dosyayı Kakule uygulamasında "Yedekleme ve Geri Yükleme > Yedek dosyası seç ve aç" ile açabilirsin.\n`
  );

  yedekIlerleme(94, "Paket sıkıştırılıyor…");
  const blob = await zip.generateAsync(
    { type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } },
    (meta) => { if (meta.percent) yedekIlerleme(94 + meta.percent * 0.06, "Paket sıkıştırılıyor…"); }
  );
  return { blob, manifest };
}

// Blob'u cihaza indirir.
function blobIndir(blob, dosyaAdi) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = dosyaAdi;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------- Yedekleme UI olayları ----------
$("yedekleme-ac-btn")?.addEventListener("click", () => {
  sakla($("modal-profil"));
  sakla($("yedek-ilerleme"));
  $("yedek-ilerleme-cubuk").style.width = "0%";
  goster($("modal-yedekleme"));
});

$("yedek-olustur-btn")?.addEventListener("click", async () => {
  const btn = $("yedek-olustur-btn");
  const medyaDahil = $("yedek-medya-dahil").checked;
  btn.disabled = true;
  const eskiMetin = btn.textContent;
  btn.textContent = "Hazırlanıyor…";
  try {
    const { blob, manifest } = await yedekPaketiUret(medyaDahil);
    const tarih = new Date().toISOString().slice(0, 10);
    blobIndir(blob, `kakule-yedek-${tarih}.zip`);
    yedekIlerleme(100, `Tamam! ${manifest.mesajSayisi} mesaj, ${manifest.sohbetSayisi} sohbet yedeklendi.`);
  } catch (err) {
    yedekIlerleme(0, "Hata: " + err.message);
    alert("Yedek oluşturulamadı: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = eskiMetin;
  }
});

// ---------- Geri yükleme / arşiv görüntüleyici ----------
let arsivVeri = null; // { profiller, sohbetler, zip }

$("yedek-geri-yukle-btn")?.addEventListener("click", () => $("yedek-geri-yukle-input").click());

$("yedek-geri-yukle-input")?.addEventListener("change", async (e) => {
  const dosya = e.target.files[0];
  e.target.value = "";
  if (!dosya) return;
  try {
    const JSZip = await jszipYukle();
    const zip = await JSZip.loadAsync(dosya);
    const veriDosya = zip.file("veri.json");
    if (!veriDosya) { alert("Bu dosya geçerli bir Kakule yedeği değil (veri.json bulunamadı)."); return; }
    const veri = JSON.parse(await veriDosya.async("string"));
    let manifest = {};
    try { manifest = JSON.parse(await zip.file("manifest.json").async("string")); } catch {}

    arsivVeri = { profiller: veri.profiller || {}, sohbetler: veri.sohbetler || [], zip };
    sakla($("modal-yedekleme"));
    arsiviAc(manifest);
  } catch (err) {
    alert("Yedek açılamadı: " + err.message);
  }
});

let arsivVeriSahip = null;

function arsivAd(uid) {
  return arsivVeri?.profiller?.[uid]?.ad || "Üye";
}

function arsivSohbetAdi(s) {
  if (s.tip === "grup") return s.ad || "Grup";
  const karsi = (s.uyeler || []).find((u) => u !== (arsivVeriSahip || ""));
  return arsivAd(karsi) || "Sohbet";
}

function arsiviAc(manifest) {
  arsivVeriSahip = manifest?.sahipUid || null;
  $("arsiv-baslik-metin").textContent = "Arşiv — " + (manifest?.sahipAd || "Yedek");
  $("arsiv-alt-metin").textContent = manifest?.olusturma
    ? new Date(manifest.olusturma).toLocaleString("tr-TR") + `  ·  ${manifest.mesajSayisi || "?"} mesaj`
    : "";

  const liste = $("arsiv-sohbet-listesi");
  liste.innerHTML = "";
  const sohbetler = (arsivVeri.sohbetler || []).slice().sort((a, b) =>
    (b.sonMesajZamani || "").localeCompare(a.sonMesajZamani || ""));

  if (!sohbetler.length) {
    liste.innerHTML = `<div class="arsiv-bos" style="padding:20px;">Bu yedekte sohbet yok.</div>`;
  }

  sohbetler.forEach((s) => {
    const oge = document.createElement("div");
    oge.className = "arsiv-sohbet-ogesi";
    oge.innerHTML = `<span class="ad">${kacir(arsivSohbetAdi(s))}</span>
      <span class="son">${kacir((s.sonMesaj || "").slice(0, 60))}</span>`;
    oge.addEventListener("click", () => {
      liste.querySelectorAll(".arsiv-sohbet-ogesi").forEach((x) => x.classList.remove("aktif"));
      oge.classList.add("aktif");
      arsivMesajlariCiz(s);
      $("arsiv-katmani").classList.add("mesaj-acik");
    });
    liste.appendChild(oge);
  });

  $("arsiv-mesaj-alani").innerHTML = `<div class="arsiv-bos">Soldan bir sohbet seç</div>`;
  $("arsiv-katmani").classList.remove("mesaj-acik");
  goster($("arsiv-katmani"));
}

// Arşivdeki medyayı (zip içinden) blob URL olarak çözer.
async function arsivMedyaUrl(yerelAd) {
  try {
    const dosya = arsivVeri.zip.file(yerelAd);
    if (!dosya) return null;
    const blob = await dosya.async("blob");
    return URL.createObjectURL(blob);
  } catch { return null; }
}

async function arsivMesajlariCiz(s) {
  const alan = $("arsiv-mesaj-alani");
  alan.innerHTML = "";
  const mesajlar = s.mesajlar || [];
  if (!mesajlar.length) { alan.innerHTML = `<div class="arsiv-bos">Bu sohbette mesaj yok.</div>`; return; }

  let sonGun = null;
  for (const m of mesajlar) {
    const gun = m.zaman ? new Date(m.zaman).toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" }) : null;
    if (gun && gun !== sonGun) {
      const g = document.createElement("div");
      g.className = "arsiv-gun";
      g.textContent = gun;
      alan.appendChild(g);
      sonGun = gun;
    }

    const giden = m.gonderenUid === arsivVeriSahip;
    const balon = document.createElement("div");
    balon.className = "arsiv-balon " + (giden ? "giden" : "gelen");

    let ic = "";
    if (s.tip === "grup" && !giden) ic += `<div class="gonderen">${kacir(arsivAd(m.gonderenUid))}</div>`;

    if (m.silindi) {
      ic += `<em style="color:var(--metin-soluk);">Bu mesaj silindi</em>`;
    } else if (m.tip === "gorsel") {
      ic += `<div data-medya="${kacir(m.yerelMedya || "")}" data-url="${kacir(m.orijinalUrl || "")}">📷 Görsel yükleniyor…</div>`;
      if (m.metin) ic += `<div style="margin-top:4px;">${kacir(m.metin)}</div>`;
    } else if (m.tip === "ses") {
      ic += `<div data-ses="${kacir(m.yerelMedya || "")}" data-url="${kacir(m.orijinalUrl || "")}">🎤 Ses yükleniyor…</div>`;
    } else if (m.tip === "dosya") {
      const url = m.orijinalUrl || "#";
      ic += `<a class="dosya" href="${kacir(url)}" target="_blank" rel="noopener">📎 ${kacir(m.dosyaAd || "Dosya")}</a>`;
    } else if (m.tip === "konum") {
      ic += `<a class="dosya" href="https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lng}#map=16/${m.lat}/${m.lng}" target="_blank" rel="noopener">📍 Konum — haritada aç</a>`;
      if (m.metin) ic += `<div style="margin-top:4px;">${kacir(m.metin)}</div>`;
    } else if (m.tip === "dogumgunu") {
      ic += `🎂 ${kacir(m.metin || ((m.dogumGunuAd || "") + " doğum günü!"))}`;
    } else {
      ic += kacir(m.metin || "");
    }

    const zamanStr = m.zaman ? new Date(m.zaman).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" }) : "";
    ic += `<div class="zaman">${zamanStr}${m.duzenlendi ? " · düzenlendi" : ""}</div>`;
    balon.innerHTML = ic;
    alan.appendChild(balon);

    // Medyayı asenkron çöz (zip içinden). Yoksa orijinal URL'e düş.
    const gorselYer = balon.querySelector("[data-medya]");
    if (gorselYer) {
      const yerel = gorselYer.getAttribute("data-medya");
      const url = yerel ? await arsivMedyaUrl(yerel) : null;
      const son = url || gorselYer.getAttribute("data-url");
      gorselYer.outerHTML = son ? `<img class="medya" src="${son}" alt="görsel" />` : "📷 (görsel yok)";
    }
    const sesYer = balon.querySelector("[data-ses]");
    if (sesYer) {
      const yerel = sesYer.getAttribute("data-ses");
      const url = yerel ? await arsivMedyaUrl(yerel) : null;
      const son = url || sesYer.getAttribute("data-url");
      sesYer.outerHTML = son ? `<audio controls preload="none" src="${son}"></audio>` : "🎤 (ses yok)";
    }
  }
  alan.scrollTop = 0;
}

$("arsiv-geri-btn")?.addEventListener("click", () => {
  // Mobilde önce mesaj alanından listeye dön; masaüstünde katmanı kapat.
  const katman = $("arsiv-katmani");
  if (katman.classList.contains("mesaj-acik") && window.matchMedia("(max-width: 640px)").matches) {
    katman.classList.remove("mesaj-acik");
    return;
  }
  sakla(katman);
  arsivVeri = null;
});

// ============================================================
// BULUŞMA — Cinematic canlı buluşma modülü
// ============================================================
// Mimari: bulusmalar/{id} belgesi buluşmanın durumunu taşır; alt-koleksiyon
// bulusmalar/{id}/katilimcilar/{uid} her katılımcının CANLI konumunu tutar.
// Konum yalnızca buluşma ekranı açıkken (watchPosition) paylaşılır ve ekran
// kapanınca watch durdurulup katılımcı belgesi silinir — gizlilik için konum
// hiçbir zaman ekran kapalıyken sunucuda kalmaz.
//
// Belge şeması:
//   bulusmalar/{id} = {
//     sohbetId, tip ('birebir'|'grup'), baslatanUid, baslatanAd,
//     davetliler: [uid...], durum: 'aktif'|'saglandi'|'bitti',
//     olusturma, saglanmaZamani?
//   }
//   bulusmalar/{id}/katilimcilar/{uid} = { ad, lat, lng, guncelleme }

function leafletYukle() {
  if (window.L) return Promise.resolve(window.L);
  if (leafletYukleniyor) return leafletYukleniyor;
  leafletYukleniyor = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    s.integrity = "sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=";
    s.crossOrigin = "";
    s.onload = () => resolve(window.L);
    s.onerror = () => reject(new Error("Harita kütüphanesi yüklenemedi (internet gerekli)."));
    document.head.appendChild(s);
  });
  return leafletYukleniyor;
}

// Haversine — iki nokta arası mesafe (metre)
function mesafeMetre(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function mesafeMetniFormatla(m) {
  if (m == null) return "—";
  if (m < 1000) return Math.round(m) + " m";
  return (m / 1000).toFixed(m < 10000 ? 2 : 1) + " km";
}

// ---------- Buluşma başlatma (davet gönderen) ----------
$("bulusma-btn")?.addEventListener("click", () => {
  if (!aktifSohbetId) return;
  if (aktifBulusmaId) { alert("Zaten bir buluşmadasın."); return; }
  if (!navigator.geolocation) { alert("Cihazın konum özelliğini desteklemiyor."); return; }
  goster($("modal-bulusma-davet"));
});

$("bulusma-baslat-onay-btn")?.addEventListener("click", async () => {
  sakla($("modal-bulusma-davet"));
  try {
    // Davetliler: birebirde karşı taraf, grupta oluşturan hariç tüm üyeler.
    const s = sohbetlerCache?.find?.((x) => x.id === aktifSohbetId);
    let davetliler = [];
    if (aktifSohbetTipi === "grup") {
      davetliler = (s?.uyeler || []).filter((u) => u !== suankiKullanici.uid);
    } else if (aktifSohbetKarsi) {
      davetliler = [aktifSohbetKarsi];
    }

    const ref = await addDoc(collection(db, "bulusmalar"), {
      sohbetId: aktifSohbetId,
      tip: aktifSohbetTipi,
      baslatanUid: suankiKullanici.uid,
      baslatanAd: suankiKullanici.ad || "Aile üyesi",
      davetliler,
      durum: "aktif",
      olusturma: serverTimestamp()
    });

    // Davetlilere bildirim gönder (push varsa). İmza: (uidler[], baslik, govde, etiket).
    if (davetliler.length) {
      pushBildirimGonder(
        davetliler,
        "Buluşma",
        `${suankiKullanici.ad || "Aile üyesi"} seni buluşmaya çağırıyor`,
        "kakule-bulusma",
        aktifSohbetId
      ).catch(() => {});
    }

    // Başlatan da haritaya girer.
    await bulusmayaKatil(ref.id);
  } catch (err) {
    alert("Buluşma başlatılamadı: " + err.message);
  }
});

// ---------- Gelen buluşma davetlerini dinle ----------
function bulusmaDavetleriniDinle() {
  if (!suankiKullanici) return;
  const q = query(
    collection(db, "bulusmalar"),
    where("davetliler", "array-contains", suankiKullanici.uid),
    where("durum", "==", "aktif")
  );
  onSnapshot(q, (snap) => {
    // Zaten bir buluşmadaysak yeni davet bildirimi gösterme.
    if (aktifBulusmaId) { sakla($("gelen-bulusma-bildirimi")); return; }
    const aktif = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((b) => b.durum === "aktif");
    if (!aktif.length) { sakla($("gelen-bulusma-bildirimi")); return; }
    const b = aktif[aktif.length - 1];
    $("gelen-bulusma-ad").textContent = b.baslatanAd || "Aile üyesi";
    $("gelen-bulusma-bildirimi").dataset.bulusmaId = b.id;
    goster($("gelen-bulusma-bildirimi"));
  });
}

$("bulusma-kabul-btn")?.addEventListener("click", async () => {
  const id = $("gelen-bulusma-bildirimi").dataset.bulusmaId;
  sakla($("gelen-bulusma-bildirimi"));
  if (id) await bulusmayaKatil(id);
});

$("bulusma-red-btn")?.addEventListener("click", () => {
  sakla($("gelen-bulusma-bildirimi"));
});

// ---------- Buluşmaya katıl (haritayı aç, konum paylaşımını başlat) ----------
async function bulusmayaKatil(bulusmaId) {
  if (!navigator.geolocation) { alert("Cihazın konum özelliğini desteklemiyor."); return; }
  aktifBulusmaId = bulusmaId;
  bulusmaSaglandiGosterildi = false;
  bulusmaSonYazim = 0;
  bulusmaSonYazilanKonum = null;
  sakla($("bulusma-saglandi-perde"));
  $("bulusma-mesafe").textContent = "—";
  $("bulusma-durum-metin").textContent = "Konum alınıyor…";
  goster($("bulusma-katmani"));

  try {
    const L = await leafletYukle();
    // Harita bir kez kurulur, sonra tekrar kullanılır.
    if (!bulusmaHarita) {
      bulusmaHarita = L.map("bulusma-harita", { zoomControl: true, attributionControl: true })
        .setView([39.0, 35.0], 6);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap"
      }).addTo(bulusmaHarita);
    } else {
      setTimeout(() => bulusmaHarita.invalidateSize(), 100);
    }

    bulusmaKatilimcilariDinle(bulusmaId);
    bulusmaBelgesiniDinle(bulusmaId);
    bulusmaKonumPaylasiminiBaslat(bulusmaId);
  } catch (err) {
    alert(err.message);
    bulusmayiBitir(false);
  }
}

// Konum paylaşımı — watchPosition + throttle. Yalnızca ekran açıkken çalışır.
function bulusmaKonumPaylasiminiBaslat(bulusmaId) {
  bulusmaKonumWatchId = navigator.geolocation.watchPosition(
    async (pos) => {
      if (aktifBulusmaId !== bulusmaId) return;
      const konum = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      const simdi = Date.now();

      // Throttle: çok sık yazma; ve anlamlı hareket yoksa yazma.
      const yeterliZaman = simdi - bulusmaSonYazim >= BULUSMA_YAZIM_ARALIK_MS;
      const yeterliHareket = !bulusmaSonYazilanKonum ||
        mesafeMetre(bulusmaSonYazilanKonum, konum) >= BULUSMA_MIN_HAREKET_M;
      if (!(yeterliZaman && yeterliHareket) && bulusmaSonYazilanKonum) return;

      bulusmaSonYazim = simdi;
      bulusmaSonYazilanKonum = konum;
      try {
        await setDoc(doc(db, "bulusmalar", bulusmaId, "katilimcilar", suankiKullanici.uid), {
          ad: suankiKullanici.ad || "Aile üyesi",
          lat: konum.lat, lng: konum.lng,
          guncelleme: serverTimestamp()
        });
      } catch { /* izin/ağ — sessiz geç */ }
    },
    (err) => {
      $("bulusma-durum-metin").textContent =
        err.code === err.PERMISSION_DENIED
          ? "Konum izni verilmedi — buluşma için konum gerekli."
          : "Konum alınamıyor…";
    },
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
  );
}

// Katılımcıların canlı konumlarını dinle ve haritayı güncelle.
function bulusmaKatilimcilariDinle(bulusmaId) {
  const L = window.L;
  bulusmaKatilimciAbonelik = onSnapshot(
    collection(db, "bulusmalar", bulusmaId, "katilimcilar"),
    (snap) => {
      if (aktifBulusmaId !== bulusmaId) return;
      const katilimcilar = snap.docs.map((d) => ({ uid: d.id, ...d.data() }))
        .filter((k) => typeof k.lat === "number" && typeof k.lng === "number");

      // Markerları güncelle/oluştur
      const gorulen = new Set();
      katilimcilar.forEach((k) => {
        gorulen.add(k.uid);
        const ben = k.uid === suankiKullanici.uid;
        const ll = [k.lat, k.lng];
        if (bulusmaMarkerlar[k.uid]) {
          bulusmaMarkerlar[k.uid].setLatLng(ll);
        } else {
          const ikon = L.divIcon({
            className: "",
            html: `<div class="bulusma-marker ${ben ? "ben" : ""}">
              <div class="madalyon">${kacir(harfBas(k.ad || "?"))}</div>
              <div class="kartus">${kacir(ben ? "Sen" : (k.ad || "Üye"))}</div>
            </div>`,
            iconSize: [46, 66], iconAnchor: [23, 23]
          });
          bulusmaMarkerlar[k.uid] = L.marker(ll, { icon: ikon }).addTo(bulusmaHarita);
        }
      });
      // Ayrılanların markerını kaldır
      Object.keys(bulusmaMarkerlar).forEach((uid) => {
        if (!gorulen.has(uid)) {
          bulusmaHarita.removeLayer(bulusmaMarkerlar[uid]);
          delete bulusmaMarkerlar[uid];
        }
      });

      bulusmaHaritayiSigdir(katilimcilar);
      bulusmaMesafeVeDurumGuncelle(bulusmaId, katilimcilar);
      bulusmaKatilimciSeridiCiz(bulusmaId, katilimcilar);
    }
  );
}

// Haritayı tüm katılımcıları içine alacak şekilde ayarla.
function bulusmaHaritayiSigdir(katilimcilar) {
  const L = window.L;
  if (!katilimcilar.length) return;
  if (katilimcilar.length === 1) {
    bulusmaHarita.setView([katilimcilar[0].lat, katilimcilar[0].lng], 16, { animate: true });
    return;
  }
  const bounds = L.latLngBounds(katilimcilar.map((k) => [k.lat, k.lng]));
  bulusmaHarita.fitBounds(bounds, { padding: [70, 90], maxZoom: 17, animate: true });
}

// Mesafeyi hesapla, altın hattı çiz, 50m'de "Buluşma Sağlandı".
function bulusmaMesafeVeDurumGuncelle(bulusmaId, katilimcilar) {
  const L = window.L;
  const ben = katilimcilar.find((k) => k.uid === suankiKullanici.uid);
  const digerleri = katilimcilar.filter((k) => k.uid !== suankiKullanici.uid);

  if (bulusmaHatti) { bulusmaHarita.removeLayer(bulusmaHatti); bulusmaHatti = null; }

  if (!ben || !digerleri.length) {
    $("bulusma-mesafe").textContent = "—";
    $("bulusma-durum-metin").textContent = ben ? "Diğerleri bekleniyor…" : "Konumun alınıyor…";
    return;
  }

  // En yakın diğer katılımcıya olan mesafe
  let enYakin = Infinity, enYakinKisi = null;
  digerleri.forEach((d) => {
    const m = mesafeMetre(ben, d);
    if (m < enYakin) { enYakin = m; enYakinKisi = d; }
  });

  $("bulusma-mesafe").textContent = mesafeMetniFormatla(enYakin);

  // İki kişilikse aralarına altın hat çiz
  if (enYakinKisi) {
    bulusmaHatti = L.polyline(
      [[ben.lat, ben.lng], [enYakinKisi.lat, enYakinKisi.lng]],
      { color: "#E8A33D", weight: 2, opacity: 0.7, dashArray: "6 8" }
    ).addTo(bulusmaHarita);
  }

  if (enYakin <= BULUSMA_YAKINLIK_METRE) {
    $("bulusma-durum-metin").textContent = "Buluşma sağlandı!";
    bulusmaSaglandiGoster();
    // Belgeyi 'saglandi' yap (yalnız başlatan yazsın; kural da bunu sınırlayabilir).
    setDoc(doc(db, "bulusmalar", bulusmaId),
      { durum: "saglandi", saglanmaZamani: serverTimestamp() },
      { merge: true }).catch(() => {});
  } else if (enYakin < 200) {
    $("bulusma-durum-metin").textContent = "Çok yakınsınız — birbirinizi arayın 👀";
  } else {
    $("bulusma-durum-metin").textContent = "Yaklaşıyorsunuz…";
  }
}

function bulusmaKatilimciSeridiCiz(bulusmaId, katilimcilar) {
  const serit = $("bulusma-katilimci-seridi");
  const aktifUidler = new Set(katilimcilar.map((k) => k.uid));
  // Davetliler + başlatan hepsini göster; konumu gelen "aktif", gelmeyen "bekliyor".
  const b = bulusmaBelgeSonHali || {};
  const hepsi = new Set([...(b.davetliler || []), b.baslatanUid].filter(Boolean));
  hepsi.add(suankiKullanici.uid);
  serit.innerHTML = "";
  hepsi.forEach((uid) => {
    const ad = uid === suankiKullanici.uid ? "Sen" : (tumUyeler[uid]?.ad || "Üye");
    const aktif = aktifUidler.has(uid);
    const rozet = document.createElement("div");
    rozet.className = "bulusma-katilimci-rozet";
    rozet.innerHTML = `<span class="nokta ${aktif ? "aktif" : "bekliyor"}"></span><span>${kacir(ad)}</span>`;
    serit.appendChild(rozet);
  });
}

let bulusmaBelgeSonHali = null;

// Buluşma belgesini dinle — biri bitirirse/sağlanırsa yansıt.
function bulusmaBelgesiniDinle(bulusmaId) {
  bulusmaBelgeAbonelik = onSnapshot(doc(db, "bulusmalar", bulusmaId), (snap) => {
    if (aktifBulusmaId !== bulusmaId) return;
    if (!snap.exists()) { bulusmayiBitir(false); return; }
    const b = snap.data();
    bulusmaBelgeSonHali = b;
    if (b.durum === "saglandi" && !bulusmaSaglandiGosterildi) {
      bulusmaSaglandiGoster();
    }
    if (b.durum === "bitti") {
      bulusmayiBitir(false);
    }
  });
}

function bulusmaSaglandiGoster() {
  if (bulusmaSaglandiGosterildi) return;
  bulusmaSaglandiGosterildi = true;
  goster($("bulusma-saglandi-perde"));
  // Mühür birkaç saniye görünür kalır, sonra harita geri gelir (buluşma açık kalır).
  setTimeout(() => sakla($("bulusma-saglandi-perde")), 3200);
}

// ---------- Buluşmayı bitir (konum paylaşımını durdur, temizle) ----------
$("bulusma-kapat-btn")?.addEventListener("click", () => bulusmayiBitir(true));

async function bulusmayiBitir(belgeyiBitir) {
  const id = aktifBulusmaId;
  aktifBulusmaId = null;

  // 1) Konum paylaşımını DERHAL durdur (gizlilik: ekran kapanınca konum akmaz).
  if (bulusmaKonumWatchId != null) {
    navigator.geolocation.clearWatch(bulusmaKonumWatchId);
    bulusmaKonumWatchId = null;
  }
  // 2) Abonelikleri kapat
  if (bulusmaKatilimciAbonelik) { bulusmaKatilimciAbonelik(); bulusmaKatilimciAbonelik = null; }
  if (bulusmaBelgeAbonelik) { bulusmaBelgeAbonelik(); bulusmaBelgeAbonelik = null; }

  // 3) Kendi canlı konum belgemi sil (sunucuda kalmasın)
  if (id) {
    deleteDoc(doc(db, "bulusmalar", id, "katilimcilar", suankiKullanici.uid)).catch(() => {});
  }

  // 4) Haritayı temizle
  Object.values(bulusmaMarkerlar).forEach((m) => { try { bulusmaHarita.removeLayer(m); } catch {} });
  bulusmaMarkerlar = {};
  if (bulusmaHatti && bulusmaHarita) { try { bulusmaHarita.removeLayer(bulusmaHatti); } catch {} bulusmaHatti = null; }

  // 5) İstenirse buluşma belgesini 'bitti' yap (başlatan bitirince)
  if (belgeyiBitir && id && bulusmaBelgeSonHali?.baslatanUid === suankiKullanici.uid) {
    setDoc(doc(db, "bulusmalar", id), { durum: "bitti" }, { merge: true }).catch(() => {});
  }

  bulusmaBelgeSonHali = null;
  bulusmaSaglandiGosterildi = false;
  sakla($("bulusma-saglandi-perde"));
  sakla($("bulusma-katmani"));
}

// Uygulama/sekme kapanırsa da konum paylaşımını bırak (güvenlik ağı).
window.addEventListener("pagehide", () => { if (aktifBulusmaId) bulusmayiBitir(false); });
document.addEventListener("visibilitychange", () => {
  // Sekme arka plana alınırsa watchPosition zaten çoğu tarayıcıda durur; ekstra güvence yok,
  // ama buluşma açıksa kullanıcı geri döndüğünde harita boyutunu tazele.
  if (!document.hidden && aktifBulusmaId && bulusmaHarita) {
    setTimeout(() => bulusmaHarita.invalidateSize(), 150);
  }
});

// ============================================================
// DEFTER — Paylaşılan Yapılacaklar Listesi
// ============================================================
// Mimari: listeler/{id} belgesi (uyeler[], ad, olusturanUid), alt-koleksiyon
// listeler/{id}/gorevler/{gorevId}. Tam ortak: her üye görev ekler, düzenler,
// siler, tamamlar. Tamamlayan kişi + zaman görünür. İsteğe bağlı son tarih.
//
// listeler/{id} = { ad, uyeler[], olusturanUid, olusturma, sonGuncelleme }
// gorevler/{gorevId} = {
//   metin, ekleyenUid, ekleyenAd, olusturma,
//   tamamlandi (bool), tamamlayanUid?, tamamlayanAd?, tamamlanmaZamani?,
//   sonTarih? (ISO string veya null)
// }

let defterListeAbonelik = null;
let defterListelerCache = [];
let aktifListeId = null;
let aktifListeVeri = null;
let aktifListeGorevAbonelik = null;
let aktifListeFiltre = "tumu";
let listeKaynakSecim = "kisi";
let listeSecilenUyeler = new Set();

// ---------- Defter sekmesi: liste kartlarını çiz + dinle ----------
function defterListeleriniDinle() {
  if (defterListeAbonelik) defterListeAbonelik();
  if (!suankiKullanici) return;
  const q = query(
    collection(db, "listeler"),
    where("uyeler", "array-contains", suankiKullanici.uid)
  );
  defterListeAbonelik = onSnapshot(q, (snap) => {
    defterListelerCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    defterListelerCache.sort((a, b) =>
      (b.sonGuncelleme?.toMillis?.() || 0) - (a.sonGuncelleme?.toMillis?.() || 0));
    defterSekmesiCiz();
  });
}

function defterSekmesiCiz() {
  const kapsayici = $("defter-listesi");
  kapsayici.innerHTML = "";

  // Başlık + yeni liste butonu
  const baslik = document.createElement("div");
  baslik.className = "defter-baslik-cubuk";
  baslik.innerHTML = `<h4>Defter</h4>
    <button class="defter-yeni-btn" id="defter-yeni-liste-btn">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
      Yeni liste
    </button>`;
  kapsayici.appendChild(baslik);
  baslik.querySelector("#defter-yeni-liste-btn").addEventListener("click", listeOlusturModaliniAc);

  if (!defterListelerCache.length) {
    const bos = document.createElement("div");
    bos.className = "defter-bos";
    bos.innerHTML = `Henüz paylaşılan liste yok.<br>Yukarıdan yeni bir liste oluştur —<br>market, ev işleri, tatil hazırlığı…`;
    kapsayici.appendChild(bos);
    return;
  }

  defterListelerCache.forEach((liste) => {
    const kart = document.createElement("div");
    kart.className = "liste-kart";
    const uyeSayisi = (liste.uyeler || []).length;
    const bekleyen = liste.bekleyenSayisi != null ? liste.bekleyenSayisi : null;
    kart.innerHTML = `
      <div class="liste-kart-ikon">📜</div>
      <div class="liste-kart-govde">
        <div class="liste-kart-ad">${kacir(liste.ad || "Liste")}</div>
        <div class="liste-kart-alt">${uyeSayisi} kişi paylaşıyor</div>
      </div>
      ${bekleyen != null ? `<div class="liste-kart-sayac">${bekleyen} bekliyor</div>` : ""}`;
    kart.addEventListener("click", () => listeyiAc(liste.id));
    kapsayici.appendChild(kart);
  });
}

// ---------- Yeni liste oluşturma ----------
function listeOlusturModaliniAc() {
  $("liste-ad-input").value = "";
  listeSecilenUyeler = new Set();
  listeKaynakSecim = "kisi";
  document.querySelectorAll(".liste-kaynak-btn").forEach((b) =>
    b.classList.toggle("aktif", b.dataset.kaynak === "kisi"));
  goster($("liste-kisi-secim-alani"));
  sakla($("liste-sohbet-secim-alani"));
  listeUyeSecimiCiz();
  listeSohbetSecimiCiz();
  goster($("modal-liste-olustur"));
}

document.querySelectorAll(".liste-kaynak-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    listeKaynakSecim = btn.dataset.kaynak;
    document.querySelectorAll(".liste-kaynak-btn").forEach((b) =>
      b.classList.toggle("aktif", b === btn));
    if (listeKaynakSecim === "kisi") {
      goster($("liste-kisi-secim-alani")); sakla($("liste-sohbet-secim-alani"));
    } else {
      sakla($("liste-kisi-secim-alani")); goster($("liste-sohbet-secim-alani"));
    }
  });
});

// Kişi seçim listesi (tüm aile üyeleri, kendisi hariç)
function listeUyeSecimiCiz() {
  const kap = $("liste-uye-secim-listesi");
  kap.innerHTML = "";
  Object.entries(tumUyeler).forEach(([uid, u]) => {
    if (uid === suankiKullanici.uid) return;
    const satir = document.createElement("label");
    satir.className = "uye-secim-ogesi";
    satir.innerHTML = `
      <div class="avatar" style="width:36px;height:36px;font-size:14px;">${harfBas(u.ad || "?")}</div>
      <span style="flex:1;">${kacir(u.ad || "Üye")}</span>
      <input type="checkbox" value="${uid}" />`;
    const cb = satir.querySelector("input");
    cb.addEventListener("change", () => {
      if (cb.checked) listeSecilenUyeler.add(uid); else listeSecilenUyeler.delete(uid);
    });
    kap.appendChild(satir);
  });
  if (!kap.children.length) {
    kap.innerHTML = `<p style="color:var(--metin-soluk);font-size:13px;padding:10px;">Henüz başka aile üyesi yok.</p>`;
  }
}

// Sohbet seçim listesi (bir sohbeti seçince o sohbetin üyeleri gelir)
function listeSohbetSecimiCiz() {
  const kap = $("liste-sohbet-secim-listesi");
  kap.innerHTML = "";
  (sohbetlerCache || []).forEach((s) => {
    const ad = s.tip === "grup" ? (s.ad || "Grup")
      : (tumUyeler[(s.uyeler || []).find((u) => u !== suankiKullanici.uid)]?.ad || "Sohbet");
    const satir = document.createElement("label");
    satir.className = "uye-secim-ogesi";
    satir.innerHTML = `
      <div class="avatar" style="width:36px;height:36px;font-size:14px;">${s.tip === "grup" ? "👥" : harfBas(ad)}</div>
      <span style="flex:1;">${kacir(ad)}</span>
      <input type="radio" name="liste-sohbet" value="${s.id}" />`;
    satir.querySelector("input").addEventListener("change", () => {
      // Sohbetin üyelerini seçilenlere al (kendisi hariç)
      listeSecilenUyeler = new Set((s.uyeler || []).filter((u) => u !== suankiKullanici.uid));
      if (!$("liste-ad-input").value.trim() && s.tip === "grup") {
        $("liste-ad-input").value = s.ad || "";
      }
    });
    kap.appendChild(satir);
  });
  if (!kap.children.length) {
    kap.innerHTML = `<p style="color:var(--metin-soluk);font-size:13px;padding:10px;">Henüz sohbet yok.</p>`;
  }
}

$("liste-olustur-btn")?.addEventListener("click", async () => {
  const ad = $("liste-ad-input").value.trim();
  if (!ad) { alert("Liste için bir ad gir."); return; }
  if (!listeSecilenUyeler.size) { alert("En az bir kişi seç."); return; }
  try {
    const uyeler = [...new Set([suankiKullanici.uid, ...listeSecilenUyeler])];
    await addDoc(collection(db, "listeler"), {
      ad, uyeler,
      olusturanUid: suankiKullanici.uid,
      olusturma: serverTimestamp(),
      sonGuncelleme: serverTimestamp()
    });
    sakla($("modal-liste-olustur"));
  } catch (err) {
    alert("Liste oluşturulamadı: " + err.message);
  }
});

// ---------- Liste görünümü ----------
function listeyiAc(listeId) {
  aktifListeId = listeId;
  aktifListeVeri = defterListelerCache.find((l) => l.id === listeId) || null;
  aktifListeFiltre = "tumu";
  document.querySelectorAll(".liste-filtre").forEach((b) =>
    b.classList.toggle("aktif", b.dataset.filtre === "tumu"));
  $("liste-baslik-metin").textContent = aktifListeVeri?.ad || "Liste";
  $("liste-alt-metin").textContent = `${(aktifListeVeri?.uyeler || []).length} kişi paylaşıyor`;
  $("liste-gorev-alani").innerHTML = "";
  goster($("liste-katmani"));
  gorevleriDinle(listeId);
}

function gorevleriDinle(listeId) {
  if (aktifListeGorevAbonelik) aktifListeGorevAbonelik();
  const q = query(
    collection(db, "listeler", listeId, "gorevler"),
    orderBy("olusturma", "asc")
  );
  aktifListeGorevAbonelik = onSnapshot(q, (snap) => {
    if (aktifListeId !== listeId) return;
    aktifListeGorevlerCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    gorevleriCiz();
    // Bekleyen sayısını liste kartında göstermek için güncelle (yalnız yerel)
    const bekleyen = aktifListeGorevlerCache.filter((g) => !g.tamamlandi).length;
    const l = defterListelerCache.find((x) => x.id === listeId);
    if (l) { l.bekleyenSayisi = bekleyen; }
  });
}

let aktifListeGorevlerCache = [];

function gorevleriCiz() {
  const alan = $("liste-gorev-alani");
  alan.innerHTML = "";

  let gorevler = aktifListeGorevlerCache;
  if (aktifListeFiltre === "bekleyen") gorevler = gorevler.filter((g) => !g.tamamlandi);
  else if (aktifListeFiltre === "biten") gorevler = gorevler.filter((g) => g.tamamlandi);

  // Bekleyenler üstte, tamamlananlar altta (tümü filtresinde)
  if (aktifListeFiltre === "tumu") {
    gorevler = [...gorevler].sort((a, b) => (a.tamamlandi ? 1 : 0) - (b.tamamlandi ? 1 : 0));
  }

  if (!gorevler.length) {
    alan.innerHTML = `<div class="liste-bos-gorev">${
      aktifListeFiltre === "biten" ? "Henüz tamamlanan görev yok." :
      aktifListeFiltre === "bekleyen" ? "Bekleyen görev yok — hepsi tamam! ✨" :
      "Bu liste boş.<br>Aşağıdan ilk görevi ekle."
    }</div>`;
    return;
  }

  gorevler.forEach((g) => alan.appendChild(gorevKartiOlustur(g)));
}

function gorevKartiOlustur(g) {
  const kart = document.createElement("div");
  kart.className = "gorev-kart" + (g.tamamlandi ? " tamam" : "");
  kart.dataset.gorevId = g.id;

  // Son tarih formatı
  let sonTarihHtml = "";
  if (g.sonTarih) {
    const d = new Date(g.sonTarih);
    const gecti = !g.tamamlandi && d.getTime() < Date.now();
    const metin = d.toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    sonTarihHtml = `<span class="etiket son-tarih ${gecti ? "gecti" : ""}">🕐 ${metin}</span>`;
  }

  let metaHtml = `<span class="etiket">${kacir(g.ekleyenAd || "Üye")}</span>${sonTarihHtml}`;
  if (g.tamamlandi && g.tamamlayanAd) {
    metaHtml += `<span class="tamamlayan">✓ ${kacir(g.tamamlayanAd)}</span>`;
  }

  kart.innerHTML = `
    <button class="gorev-onay" title="${g.tamamlandi ? "Geri al" : "Tamamlandı işaretle"}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>
    </button>
    <div class="gorev-govde">
      <div class="gorev-metin">${kacir(g.metin || "")}</div>
      <div class="gorev-meta">${metaHtml}</div>
    </div>
    <div class="gorev-aksiyon">
      <button class="gorev-duzenle" title="Düzenle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
      </button>
      <button class="gorev-sil" title="Sil">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
      </button>
    </div>`;

  // Tamamlama toggle
  kart.querySelector(".gorev-onay").addEventListener("click", () => gorevTamamlaToggle(g));
  kart.querySelector(".gorev-duzenle").addEventListener("click", () => gorevDuzenle(g));
  kart.querySelector(".gorev-sil").addEventListener("click", () => gorevSil(g));

  return kart;
}

async function gorevTamamlaToggle(g) {
  if (!aktifListeId) return;
  try {
    const ref = doc(db, "listeler", aktifListeId, "gorevler", g.id);
    if (g.tamamlandi) {
      await updateDoc(ref, {
        tamamlandi: false,
        tamamlayanUid: deleteField(),
        tamamlayanAd: deleteField(),
        tamamlanmaZamani: deleteField()
      });
    } else {
      await updateDoc(ref, {
        tamamlandi: true,
        tamamlayanUid: suankiKullanici.uid,
        tamamlayanAd: suankiKullanici.ad || "Üye",
        tamamlanmaZamani: serverTimestamp()
      });
    }
    listeSonGuncellemeDokun();
  } catch (err) { alert("İşaretlenemedi: " + err.message); }
}

async function gorevDuzenle(g) {
  const yeni = prompt("Görevi düzenle:", g.metin || "");
  if (yeni == null) return;
  const temiz = yeni.trim();
  if (!temiz) return;
  try {
    await updateDoc(doc(db, "listeler", aktifListeId, "gorevler", g.id), { metin: temiz });
    listeSonGuncellemeDokun();
  } catch (err) { alert("Düzenlenemedi: " + err.message); }
}

async function gorevSil(g) {
  if (!confirm("Bu görevi silmek istediğine emin misin?")) return;
  try {
    await deleteDoc(doc(db, "listeler", aktifListeId, "gorevler", g.id));
    listeSonGuncellemeDokun();
  } catch (err) { alert("Silinemedi: " + err.message); }
}

// Liste "sonGuncelleme" alanını dokun (sıralama için) — hatayı yut.
function listeSonGuncellemeDokun() {
  if (!aktifListeId) return;
  updateDoc(doc(db, "listeler", aktifListeId), { sonGuncelleme: serverTimestamp() }).catch(() => {});
}

// ---------- Görev ekleme ----------
$("gorev-tarih-toggle")?.addEventListener("click", () => {
  const inp = $("gorev-tarih-input");
  const acik = inp.classList.toggle("gizli");
  $("gorev-tarih-toggle").classList.toggle("aktif", !acik);
  if (!acik) inp.focus();
});

async function gorevEkle() {
  const metin = $("gorev-metin-input").value.trim();
  if (!metin || !aktifListeId) return;
  const tarihVal = $("gorev-tarih-input").value;
  try {
    await addDoc(collection(db, "listeler", aktifListeId, "gorevler"), {
      metin,
      ekleyenUid: suankiKullanici.uid,
      ekleyenAd: suankiKullanici.ad || "Üye",
      tamamlandi: false,
      sonTarih: tarihVal ? new Date(tarihVal).toISOString() : null,
      olusturma: serverTimestamp()
    });
    $("gorev-metin-input").value = "";
    $("gorev-tarih-input").value = "";
    $("gorev-tarih-input").classList.add("gizli");
    $("gorev-tarih-toggle").classList.remove("aktif");
    listeSonGuncellemeDokun();
  } catch (err) { alert("Görev eklenemedi: " + err.message); }
}

$("gorev-ekle-btn")?.addEventListener("click", gorevEkle);
$("gorev-metin-input")?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); gorevEkle(); }
});

// ---------- Filtre + geri + liste sil ----------
document.querySelectorAll(".liste-filtre").forEach((btn) => {
  btn.addEventListener("click", () => {
    aktifListeFiltre = btn.dataset.filtre;
    document.querySelectorAll(".liste-filtre").forEach((b) => b.classList.toggle("aktif", b === btn));
    gorevleriCiz();
  });
});

$("liste-geri-btn")?.addEventListener("click", () => {
  if (aktifListeGorevAbonelik) { aktifListeGorevAbonelik(); aktifListeGorevAbonelik = null; }
  aktifListeId = null;
  aktifListeGorevlerCache = [];
  sakla($("liste-katmani"));
  defterSekmesiCiz();
});

$("liste-sil-btn")?.addEventListener("click", async () => {
  if (!aktifListeId) return;
  if (!confirm("Bu listeyi ve içindeki tüm görevleri silmek istediğine emin misin? Bu işlem geri alınamaz.")) return;
  try {
    // Önce görevleri sil, sonra liste belgesini.
    const gorevSnap = await getDocs(collection(db, "listeler", aktifListeId, "gorevler"));
    await Promise.all(gorevSnap.docs.map((d) => deleteDoc(d.ref).catch(() => {})));
    await deleteDoc(doc(db, "listeler", aktifListeId));
    if (aktifListeGorevAbonelik) { aktifListeGorevAbonelik(); aktifListeGorevAbonelik = null; }
    aktifListeId = null;
    sakla($("liste-katmani"));
  } catch (err) { alert("Liste silinemedi: " + err.message); }
});

// ============================================================
// PREMIUM DOKUNMATİK — Copper ripple (dokunma dalgası)
// ============================================================
// Butonlara basınca dokunma noktasından yayılan bakır parıltı. Museum-kiosk
// kalitesinde ince geri bildirim; agresif değil. Olay delegasyonuyla tüm
// mevcut ve gelecek butonlara uygulanır.
(function () {
  const HEDEF = ".btn-ana, .btn-ikincil, .icon-btn, .liste-kart, .gorev-onay, .defter-yeni-btn, .sekme, .liste-filtre, .tema-secim-kart";
  function ripple(e) {
    const el = e.target.closest(HEDEF);
    if (!el) return;
    // Konumlandırma için relative gerekiyor; değilse geçici ekle.
    const stil = getComputedStyle(el);
    if (stil.position === "static") el.style.position = "relative";
    if (stil.overflow !== "hidden") el.style.overflow = "hidden";

    const rect = el.getBoundingClientRect();
    const nokta = e.touches ? e.touches[0] : e;
    const boyut = Math.max(rect.width, rect.height);
    const d = document.createElement("span");
    d.className = "ripple-dalga";
    d.style.width = d.style.height = boyut + "px";
    d.style.left = ((nokta.clientX ?? rect.left + rect.width / 2) - rect.left - boyut / 2) + "px";
    d.style.top = ((nokta.clientY ?? rect.top + rect.height / 2) - rect.top - boyut / 2) + "px";
    el.appendChild(d);
    setTimeout(() => d.remove(), 560);
  }
  // pointerdown hem dokunma hem fareyi kapsar
  document.addEventListener("pointerdown", ripple, { passive: true });
})();

// ============================================================
// SOHBET YÖNETİMİ (sabitle/sessize) · MEDYA GALERİSİ · YILDIZ · GRUPTAN AYRIL
// ============================================================

// --- Sohbet yönetim menüsü butonları ---
$("sohbet-yonetim-sabitle")?.addEventListener("click", sohbetSabitleToggle);
$("sohbet-yonetim-sessize")?.addEventListener("click", sohbetSessizeToggle);
$("sohbet-yonetim-sil")?.addEventListener("click", sohbetSilBenimIcin);

// ============================================================
// SOHBET BAŞLIĞI "DİĞER" (⋮) AÇILIR MENÜSÜ
// ============================================================
// Sohbet üst barındaki ikon sayısını azaltmak için Buluşma başlat /
// Grup üyeleri / Medya galerisi / Sohbette ara butonları buraya
// taşındı. Bunlar proxy değil — gerçek butonların kendisi; sadece
// DOM'da bu menünün içine taşındılar, id'leri ve mevcut event
// listener'ları (mesaj-arama-btn, medya-galeri-btn, grup-uyeler-btn,
// bulusma-btn) hiç değişmeden aynen çalışmaya devam ediyor.
(function sohbetMenuKur() {
  const buton = $("sohbet-menu-btn");
  const menu = $("sohbet-menu-dropdown");
  if (!buton || !menu) return;

  function menuyuAc() { menu.classList.remove("gizli"); }
  function menuyuKapat() { menu.classList.add("gizli"); }
  function menuyuToggle(e) {
    e.stopPropagation();
    if (menu.classList.contains("gizli")) menuyuAc();
    else menuyuKapat();
  }

  buton.addEventListener("click", menuyuToggle);

  // Dışarı tıklayınca veya Esc'e basınca kapat.
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("gizli") && !menu.contains(e.target) && e.target !== buton) {
      menuyuKapat();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") menuyuKapat();
  });

  // Menü içindeki herhangi bir ögeye tıklanınca (asıl işlev zaten kendi
  // listener'ında çalışır), menüyü de kapat.
  menu.addEventListener("click", (e) => {
    if (e.target.closest(".ust-menu-oge")) menuyuKapat();
  });
})();

// ============================================================
// ÜST "DİĞER" (⋮) AÇILIR MENÜSÜ
// ============================================================
// Üst bardaki ikon sayısını azaltmak için Profilim / Davetiye oluştur /
// Yeni grup / Admin Paneli / Çıkış yap butonları burada toplanıyor. Bu
// menüdeki her öge, DOM'da hâlâ duran ama CSS ile gizlenmiş asıl butona
// (örn. #profil-duzenle-btn) proxy bir tıklama yapıyor — böylece o
// butonlara bağlı mevcut event listener'lar değişmeden çalışmaya devam ediyor.
(function ustMenuKur() {
  const buton = $("ust-menu-btn");
  const menu = $("ust-menu-dropdown");
  if (!buton || !menu) return;

  function menuyuAc() { menu.classList.remove("gizli"); }
  function menuyuKapat() { menu.classList.add("gizli"); }
  function menuyuToggle(e) {
    e.stopPropagation();
    if (menu.classList.contains("gizli")) menuyuAc();
    else menuyuKapat();
  }

  buton.addEventListener("click", menuyuToggle);

  // Dışarı tıklayınca veya Esc'e basınca kapat.
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("gizli") && !menu.contains(e.target) && e.target !== buton) {
      menuyuKapat();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") menuyuKapat();
  });

  // Her öge, gerçek (gizli) butona proxy tıklama yapıp menüyü kapatır.
  const eslesmeler = [
    ["ust-menu-profil", "profil-duzenle-btn"],
    ["ust-menu-davet", "davet-olustur-btn"],
    ["ust-menu-yeni-grup", "yeni-grup-btn"],
    ["ust-menu-admin", "admin-panel-btn"],
    ["ust-menu-cikis", "cikis-btn"]
  ];
  eslesmeler.forEach(([dropdownId, gercekId]) => {
    $(dropdownId)?.addEventListener("click", () => {
      menuyuKapat();
      $(gercekId)?.click();
    });
  });
})();
$("sohbet-yonetim-medya")?.addEventListener("click", () => {
  sakla($("modal-sohbet-yonetim"));
  // Mevcut (lightbox'lı) medya galerisini aç
  $("medya-galeri-btn")?.click();
});

// --- Mesaj yıldızlama (favoriler) ---
// Yıldız durumu mesaj belgesinde per-kullanıcı dizi olarak tutulur: yildizlayanlar[]
$("mesaj-yildizla-btn")?.addEventListener("click", async () => {
  const m = mesajlarCache.find((x) => x.id === secilenMesajId);
  sakla($("modal-mesaj-aksiyon"));
  if (!m || !aktifSohbetId) return;
  const yildizli = (m.yildizlayanlar || []).includes(suankiKullanici.uid);
  try {
    await updateDoc(doc(db, "sohbetler", aktifSohbetId, "mesajlar", m.id), {
      yildizlayanlar: yildizli ? arrayRemove(suankiKullanici.uid) : arrayUnion(suankiKullanici.uid)
    });
  } catch (e) { alert("Yıldızlanamadı: " + e.message); }
});

// Yıldızlı mesajları tüm sohbetlerden topla ve göster
async function yildizliMesajlariAc() {
  $("yildizli-icerik").innerHTML = `<div style="text-align:center;color:var(--metin-soluk);padding:20px;">Yükleniyor…</div>`;
  goster($("modal-yildizli"));
  try {
    const bulunan = [];
    // Kullanıcının üye olduğu her sohbette yıldızlı mesajları ara
    for (const s of sohbetlerCache) {
      const snap = await getDocs(query(
        collection(db, "sohbetler", s.id, "mesajlar"),
        where("yildizlayanlar", "array-contains", suankiKullanici.uid)
      ));
      snap.docs.forEach((d) => {
        const m = { id: d.id, ...d.data(), sohbetId: s.id };
        m.sohbetAd = s.tip === "grup" ? (s.ad || "Grup")
          : (tumUyeler[(s.uyeler || []).find((u) => u !== suankiKullanici.uid)]?.ad || "Sohbet");
        bulunan.push(m);
      });
    }
    bulunan.sort((a, b) => (b.zaman?.toMillis?.() || 0) - (a.zaman?.toMillis?.() || 0));
    if (!bulunan.length) {
      $("yildizli-icerik").innerHTML = `<div style="text-align:center;color:var(--metin-soluk);padding:30px;">Henüz yıldızlı mesaj yok.<br>Bir mesaja uzun basıp ⭐ Yıldızla de.</div>`;
      return;
    }
    $("yildizli-icerik").innerHTML = "";
    bulunan.forEach((m) => {
      const el = document.createElement("div");
      el.className = "yildizli-oge";
      const ozet = m.silindi ? "(silindi)" : (m.metin || (m.tip === "gorsel" ? "📷 Görsel" : m.tip === "ses" ? "🎤 Ses" : m.tip === "dosya" ? "📎 Dosya" : m.tip === "konum" ? "📍 Konum" : ""));
      el.innerHTML = `
        <div class="yildizli-ust"><span class="yildizli-sohbet">${kacir(m.sohbetAd)}</span><span class="yildizli-zaman">${m.zaman ? zamanFormatla(m.zaman) : ""}</span></div>
        <div class="yildizli-metin">${kacir(ozet)}</div>
        <div class="yildizli-gonderen">— ${kacir(tumUyeler[m.gonderenUid]?.ad || "Üye")}</div>`;
      el.addEventListener("click", () => {
        sakla($("modal-yildizli"));
        const s = sohbetlerCache.find((x) => x.id === m.sohbetId);
        if (s) sohbetAc(s.id, s.tip, s.tip === "grup" ? null : s.uyeler.find((u) => u !== suankiKullanici.uid));
      });
      $("yildizli-icerik").appendChild(el);
    });
  } catch (e) {
    $("yildizli-icerik").innerHTML = `<div style="color:var(--hata);padding:20px;">Yüklenemedi: ${kacir(e.message)}</div>`;
  }
}

// --- Gruptan ayrılma ---
async function gruptanAyril() {
  if (aktifSohbetTipi !== "grup" || !aktifSohbetId) return;
  if (!confirm("Bu gruptan ayrılmak istediğine emin misin? Tekrar eklenmen için bir üyenin seni davet etmesi gerekir.")) return;
  try {
    await updateDoc(doc(db, "sohbetler", aktifSohbetId), {
      uyeler: arrayRemove(suankiKullanici.uid)
    });
    // Sohbeti kapat, listeye dön
    aktifSohbetId = null; aktifSohbetTipi = null;
    sakla($("sohbet-aktif"));
    goster($("karsilama-ekrani"));
    if (window.innerWidth <= 760) {
      $("panel-liste").classList.remove("gizli-mobil");
      $("panel-sohbet").classList.add("gizli-mobil");
    }
  } catch (e) { alert("Ayrılınamadı: " + e.message); }
}

// Gruptan ayrıl + yıldızlı mesajlar erişim butonları
$("gruptan-ayril-btn")?.addEventListener("click", () => {
  sakla($("modal-grup-uyeler"));
  gruptanAyril();
});
$("yildizli-ac-btn")?.addEventListener("click", () => {
  sakla($("modal-profil"));
  yildizliMesajlariAc();
});
