// ============================================================
// FIREBASE YAPILANDIRMASI
// ============================================================
// Bu dosyayı kendi Firebase projenizin bilgileriyle doldurun.
// Nereden bulunur: Firebase Console > Project Settings > Genel
// (Bu bilgiler "gizli" değildir, tarayıcıda görünür olmaları normaldir.
//  Gerçek güvenlik Firestore/Storage "kurallar" dosyalarıyla sağlanır.)
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyCyLuDOlNGsJzSm7uAPa38CrROsu6UqEPs",
  authDomain: "kakule-ba0b2.firebaseapp.com",
  projectId: "kakule-ba0b2",
  storageBucket: "kakule-ba0b2.firebasestorage.app",
  messagingSenderId: "683562735556",
  appId: "1:683562735556:web:f9ea575cbe7f818a753691"
};

// Bu kod ailenize özel "kuruluş anahtarı" — ilk admin hesabını
// oluştururken kullanılır. Kurulumdan sonra istersen değiştirebilirsin.
export const KURULUS_ANAHTARI = "ailem-2026-ocak";

// ============================================================
// CLOUDINARY YAPILANDIRMASI (dosya/görsel yükleme — ücretsiz)
// ============================================================
// Nereden bulunur:
//   1. https://cloudinary.com adresine gidin, ücretsiz hesap açın.
//   2. Dashboard'da "Cloud Name" değerini buraya yapıştırın.
//   3. Settings > Upload > "Add upload preset" → Signing Mode: "Unsigned"
//      seçin → bir isim verin (örn: kakule) → kaydedin.
//   4. O preset adını CLOUDINARY_PRESET'e yapıştırın.
// ============================================================
export const CLOUDINARY_CLOUD = "dv56qsrcf";   // örn: "my-family-app"
export const CLOUDINARY_PRESET = "kakule";  // örn: "kakule"

// ============================================================
// PUSH BİLDİRİM YAPILANDIRMASI (Cloudflare Worker — ücretsiz, kart istemiyor)
// ============================================================
// VAPID_PUBLIC_KEY: aşağıdaki hazır değeri kullanabilirsin (sizin için üretildi).
// Bunu DEĞİŞTİRMEK İSTERSEN, KURULUM.md'deki "Push Bildirim Kurulumu" bölümündeki
// adımı takip et; yeni bir çift üretip hem buraya hem Cloudflare Worker'a yapıştır.
export const VAPID_PUBLIC_KEY = "BKDsF7BHYzuQ0L8wEwwDC5YXYGh3m8lC_b2KyLxw-YlL-HvTzcoWnf1ItWAI_HzAJCyL8qFQriOVHdNcXSBkorM";

// CF_WORKER_URL: Cloudflare Worker'ı yayınladıktan sonra aldığınız adresi buraya yapıştırın.
// Örnek: "https://kakule-push.kullaniciadi.workers.dev"
export const CF_WORKER_URL = "BURAYA_WORKER_ADRESI";

// NOT: Worker'ı yabancılara karşı koruyan paylaşım anahtarı BURADA DEĞİL —
// bilerek bu dosyaya (yani GitHub'a) konulmadı, çünkü bu dosya herkese açık.
// Onun yerine Firestore'da, sadece giriş yapmış (davetiyeli) aile üyelerinin
// okuyabildiği bir belgede saklanıyor. Kurulumu KURULUM.md'deki "2c. Worker
// paylaşım anahtarını Firestore'a ekleyin" bölümünde anlatılıyor.

// ============================================================
// TURN SUNUCUSU (opsiyonel — sesli/görüntülü aramada bağlantı sorunları için)
// ============================================================
// Ne zaman gerekir: Aile üyelerinden biri mobil veri, diğeri Wi-Fi'deyken (veya bazı
// operatör/router ağlarında) arama hiç bağlanmıyorsa, STUN yetersiz kalmış demektir —
// bu durumda bir TURN sunucusu trafiği aktarmak için devreye girer.
// Doldurmazsanız uygulama yalnızca STUN ile çalışır (aynı Wi-Fi'de genelde sorunsuzdur).
//
// Ücretsiz seçenek (Metered.ca):
//   1. https://www.metered.ca/tools/openrelay/ adresinden ücretsiz hesap açın.
//   2. Dashboard'da size verilen TURN adresini, kullanıcı adını ve şifreyi alın.
//   3. Aşağıdaki üç değeri doldurun.
export const TURN_URL = "BURAYA_TURN_URL";          // örn: "turn:standard.relay.metered.ca:80"
export const TURN_KULLANICI = "BURAYA_TURN_KULLANICI";
export const TURN_SIFRE = "BURAYA_TURN_SIFRE";
