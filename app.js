<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, maximum-scale=1" />
<title>Kakule</title>
<meta name="theme-color" content="#14171C" />
<link rel="manifest" href="manifest.json" />
<link rel="apple-touch-icon" href="icons/icon-180.png" />
<link rel="icon" type="image/png" sizes="32x32" href="icons/icon-32.png" />
<link rel="icon" type="image/png" sizes="64x64" href="icons/icon-64.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=" crossorigin="" />
<link rel="stylesheet" href="style.css" />
<script>
  // Tema, sayfa boyanmadan önce uygulansın diye (yanıp sönmeyi engellemek için)
  // erken ve senkron çalışan küçük bir betik — ana mantık app.js içinde.
  try {
    var t = localStorage.getItem("kakule-tema");
    var gecerli = ["koyu", "acik", "bohem", "bohem-acik", "yesil", "yesil-acik"];
    if (gecerli.indexOf(t) === -1) {
      t = (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) ? "acik" : "koyu";
    }
    document.documentElement.setAttribute("data-tema", t);
  } catch (e) {}
</script>
</head>
<body>

<!-- ===================== BAŞLANGIÇ YÜKLENİYOR EKRANI =====================
     Firebase'in "bu kullanıcı zaten giriş yapmış mı?" kontrolü (onAuthStateChanged)
     IndexedDB'den okuduğu için bir miktar sürüyor. O süre boyunca giriş ekranını
     GÖSTERMEK yerine nötr bir yükleniyor ekranı gösteriyoruz — böylece zaten giriş
     yapmış kullanıcı, açılışta bir anlığına giriş formunu "titrek" görmüyor.
     app.js, onAuthStateChanged sonucu belli olunca bu ekranı gizleyip doğru
     ekranı (giriş formu ya da uygulama) gösteriyor. -->
<div id="baslangic-yukleniyor" class="baslangic-yukleniyor">
  <img class="auth-logo" src="icons/icon-seffaf-512.png" alt="Kakule" />
</div>

<!-- ===================== GİRİŞ / KAYIT EKRANI ===================== -->
<div id="auth-sayfa" class="auth-sayfa gizli">
  <div class="auth-kart">
    <img class="auth-logo" src="icons/icon-seffaf-512.png" alt="Kakule" />
    <img class="auth-wordmark" src="icons/kakule-wordmark.png" alt="Kakule" />
    <p class="auth-alt">Sadece ailenize özel, kapalı sohbet</p>

    <div id="auth-hata" class="hata-mesaji gizli"></div>
    <div id="auth-basari" class="basari-mesaji gizli"></div>

    <!-- GİRİŞ FORMU -->
    <form id="giris-form">
      <div class="alan">
        <label>E-posta</label>
        <input type="email" id="giris-eposta" required autocomplete="email" />
      </div>
      <div class="alan">
        <label>Şifre</label>
        <input type="password" id="giris-sifre" required autocomplete="current-password" />
      </div>
      <button type="submit" class="btn-ana">Giriş yap</button>
    </form>
    <button id="sifremi-unuttum-ac" class="btn-metin">Şifremi unuttum</button>
    <button id="kayit-ekrani-ac" class="btn-metin">Davetiye kodun var mı? Hesap oluştur</button>

    <!-- ŞİFRE SIFIRLAMA FORMU -->
    <form id="sifre-sifirla-form" class="gizli">
      <div class="alan">
        <label>E-posta</label>
        <input type="email" id="sifirla-eposta" required autocomplete="email" />
      </div>
      <button type="submit" class="btn-ana">Sıfırlama bağlantısı gönder</button>
    </form>
    <button id="sifre-sifirla-iptal" class="btn-metin gizli">Girişe dön</button>

    <!-- KAYIT FORMU -->
    <form id="kayit-form" class="gizli">
      <div class="alan">
        <label>Davetiye kodu</label>
        <input type="text" id="kayit-davet-kodu" required placeholder="Aileden aldığın kod" autocomplete="off" />
        <div id="davet-kodu-aciklama" class="gizli" style="font-size:12px;color:var(--basari,#4ade80);margin-top:4px;">✓ Davetiye kodu bağlantıdan otomatik dolduruldu.</div>
      </div>
      <div class="alan">
        <label>Adın</label>
        <input type="text" id="kayit-ad" required placeholder="Görünecek adın" />
      </div>
      <div class="alan">
        <label>Doğum tarihin</label>
        <input type="date" id="kayit-dogum-tarihi" required />
      </div>
      <div class="alan">
        <label>E-posta</label>
        <input type="email" id="kayit-eposta" required autocomplete="email" />
      </div>
      <div class="alan">
        <label>Şifre (en az 6 karakter)</label>
        <input type="password" id="kayit-sifre" required minlength="6" autocomplete="new-password" />
      </div>
      <button type="submit" class="btn-ana">Hesabı oluştur</button>
    </form>
    <button id="giris-ekrani-ac" class="btn-metin gizli">Zaten hesabın var mı? Giriş yap</button>
  </div>
</div>

<!-- ===================== ANA UYGULAMA ===================== -->
<div id="uygulama" class="uygulama gizli">

  <!-- SOL: SOHBET / GRUP LİSTESİ -->
  <div id="panel-liste" class="panel-liste">
    <!-- Marka şeridi: iPhone'larda çentik/Dynamic Island altında kalan
         asıl başlık satırını (liste-ust) aşağı iter, böylece butonlar
         tıklanabilir hale gelir. env(safe-area-inset-top) sayesinde
         çentikli cihazlarda otomatik daha uzun oluyor. -->
    <div class="marka-serit">
      <img src="icons/kakule-wordmark.png" alt="Kakule" class="marka-serit-logo" />
    </div>
    <div class="liste-ust">
      <h1>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2C9 7 6 10 6 15a6 6 0 0012 0c0-3-1.5-5-2.5-6.5 0 2.5-1.5 3.5-2.5 3.5 1-4-1-7.5-1-10z"/></svg>
        Kakule
      </h1>
      <div class="ust-aksiyonlar">
        <!-- Tema ve SOS butonları artık doğrudan görünmüyor (yer kaplamasınlar diye);
             mevcut JS mantığı bunlara bağlı olduğu için DOM'da kalıyorlar ama
             gizliler. Aşağıdaki "Diğer" (⋮) menüsündeki karşılıkları bunlara
             proxy tıklama yapıyor (bkz. app.js "ustMenuKur" bölümü). -->
        <button class="icon-btn gizli" id="tema-degistir-btn" title="Karanlık/aydınlık tema">
          <svg id="tema-ikon-ay" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>
          <svg id="tema-ikon-gunes" class="gizli" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        </button>
        <button class="icon-btn gizli" id="sos-btn" title="Acil Durum (SOS)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
        </button>
        <div class="ust-menu-wrap">
          <button class="icon-btn" id="ust-menu-btn" title="Diğer">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
          </button>
          <div id="ust-menu-dropdown" class="ust-menu-dropdown gizli">
            <button class="ust-menu-oge" id="ust-menu-profil">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0116 0v1"/></svg>
              Profilim
            </button>
            <button class="ust-menu-oge" id="ust-menu-davet">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>
              Davetiye oluştur
            </button>
            <button class="ust-menu-oge" id="ust-menu-yeni-grup">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
              Yeni grup
            </button>
            <button class="ust-menu-oge gizli" id="ust-menu-admin">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
              Admin Paneli
            </button>
            <div class="ust-menu-ayrac"></div>
            <button class="ust-menu-oge" id="ust-menu-tema">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
              Gece/gündüz modu
            </button>
            <button class="ust-menu-oge ust-menu-tehlike" id="ust-menu-sos">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
              Acil Durum (SOS)
            </button>
            <div class="ust-menu-ayrac"></div>
            <button class="ust-menu-oge ust-menu-tehlike" id="ust-menu-cikis">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
              Çıkış yap
            </button>
          </div>
        </div>

        <!-- Aşağıdaki butonlar artık doğrudan görünmüyor (yer kaplamasınlar diye);
             mevcut JS mantığı bunlara bağlı olduğu için DOM'da kalıyorlar ama
             gizliler. Yukarıdaki "Diğer" (⋮) menüsündeki karşılıkları bunlara
             proxy tıklama yapıyor (bkz. app.js "$('ust-menu-...')" bölümü). -->
        <button class="icon-btn gizli" id="profil-duzenle-btn" title="Profilim">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0116 0v1"/></svg>
        </button>
        <button class="icon-btn gizli" id="davet-olustur-btn" title="Davetiye oluştur">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/></svg>
        </button>
        <button class="icon-btn gizli" id="yeni-grup-btn" title="Yeni grup">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
        </button>
        <button class="icon-btn gizli" id="admin-panel-btn" title="Admin Paneli">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        </button>
        <button class="icon-btn gizli" id="cikis-btn" title="Çıkış yap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
        </button>
      </div>
    </div>

    <div class="sekme-cubuk sekme-cubuk-ikonlu">
      <button class="sekme aktif" data-sekme="sohbetler">
        <img class="sekme-ikon" src="icons/gradyan/sohbet.png" alt="" />
        <span class="sekme-etiket">Sohbetler</span>
        <span class="sekme-rozet gizli"></span>
      </button>
      <button class="sekme" data-sekme="kisiler">
        <img class="sekme-ikon" src="icons/gradyan/grup.png" alt="" />
        <span class="sekme-etiket">Üyeler</span>
      </button>
      <button class="sekme" data-sekme="defter">
        <img class="sekme-ikon" src="icons/gradyan/yapilacak.png" alt="" />
        <span class="sekme-etiket">Defter</span>
      </button>
      <button class="sekme" data-sekme="dogumgunleri">
        <img class="sekme-ikon" src="icons/gradyan/takvim.png" alt="" />
        <span class="sekme-etiket">Doğum G.</span>
      </button>
    </div>

    <div id="statu-seridi" class="statu-seridi"></div>

    <div id="sohbet-listesi" class="liste-govde"></div>
    <div id="kisi-listesi" class="liste-govde gizli"></div>
    <div id="defter-listesi" class="liste-govde gizli"></div>
    <div id="dogumgunu-listesi" class="liste-govde gizli"></div>
  </div>

  <!-- SAĞ: AKTİF SOHBET -->
  <div id="panel-sohbet" class="panel-sohbet gizli-mobil">
    <!-- Marka şeridi: iPhone'larda çentik/Dynamic Island altında kalan
         asıl başlık satırını (sohbet-ust) aşağı iter, böylece avatar ve
         butonlar tıklanabilir hale gelir. -->
    <div class="marka-serit">
      <img src="icons/kakule-wordmark.png" alt="Kakule" class="marka-serit-logo" />
    </div>
    <div id="karsilama-ekrani" class="karsilama-ekrani">
      <img class="karsilama-ikon" src="icons/gradyan/kalp.png" alt="" />
      <h2>Bir sohbet seç</h2>
      <p>Soldaki listeden bir aile üyesi veya grup seçerek sohbete başla.</p>
    </div>

    <div id="sohbet-aktif" class="gizli" style="display:flex;flex-direction:column;flex:1;min-height:0;position:relative;">
      <div class="sohbet-ust">
        <button class="icon-btn geri-btn" id="geri-btn">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        </button>
        <div id="sohbet-avatar" class="avatar">A</div>
        <div class="baslik-blok">
          <div class="ad" id="sohbet-baslik-ad">—</div>
          <div class="durum" id="sohbet-baslik-durum"></div>
        </div>
        <div class="arama-btnler">
          <!-- Sessize al / Sesli ara / Görüntülü ara butonları artık doğrudan
               görünmüyor (yer kaplamasınlar diye); mevcut JS mantığı bunlara
               bağlı olduğu için DOM'da kalıyorlar ama gizliler. Aşağıdaki
               "Diğer" (⋮) menüsündeki karşılıkları bunlara proxy tıklama
               yapıyor (bkz. app.js "sohbetMenuKur" bölümü). -->
          <button class="icon-btn gizli" id="sohbet-sessiz-btn" title="Sohbeti sessize al">
            <svg id="sohbet-sessiz-ikon-acik" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
            <svg id="sohbet-sessiz-ikon-kapali" class="gizli" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8.7 3.7A6 6 0 0118 8c0 3.3.7 5.6 1.4 7.1M17.5 17.5C16.2 18.6 15 19 15 19H3s3-2 3-9c0-.7.1-1.3.3-1.9"/><path d="M13.73 21a2 2 0 01-3.46 0"/><path d="M1 1l22 22"/></svg>
          </button>
          <button class="icon-btn gizli" id="sesli-arama-btn" title="Sesli ara">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
          </button>
          <button class="icon-btn gizli" id="goruntulu-arama-btn" title="Görüntülü ara">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
          </button>
          <div class="ust-menu-wrap">
            <button class="icon-btn" id="sohbet-menu-btn" title="Diğer">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
            </button>
            <div id="sohbet-menu-dropdown" class="ust-menu-dropdown gizli">
              <button class="ust-menu-oge" id="sohbet-menu-sesli-arama">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
                Sesli ara
              </button>
              <button class="ust-menu-oge" id="sohbet-menu-goruntulu-arama">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
                Görüntülü ara
              </button>
              <button class="ust-menu-oge" id="sohbet-menu-sessiz">
                <svg id="sohbet-menu-sessiz-ikon-acik" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>
                <svg id="sohbet-menu-sessiz-ikon-kapali" class="gizli" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M8.7 3.7A6 6 0 0118 8c0 3.3.7 5.6 1.4 7.1M17.5 17.5C16.2 18.6 15 19 15 19H3s3-2 3-9c0-.7.1-1.3.3-1.9"/><path d="M13.73 21a2 2 0 01-3.46 0"/><path d="M1 1l22 22"/></svg>
                <span id="sohbet-menu-sessiz-etiket">Sohbeti sessize al</span>
              </button>
              <div class="ust-menu-ayrac"></div>
              <button class="ust-menu-oge" id="bulusma-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
                Buluşma başlat
              </button>
              <button class="ust-menu-oge gizli" id="grup-uyeler-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a7 7 0 0114 0v1"/></svg>
                Grup üyeleri
              </button>
              <button class="ust-menu-oge" id="medya-galeri-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                Medya galerisi
              </button>
              <button class="ust-menu-oge" id="mesaj-arama-btn">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
                Sohbette ara
              </button>
            </div>
          </div>
        </div>
      </div>

      <div id="sabit-banner" class="sabit-banner gizli">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M12 2l1.5 5.5L19 9l-5.5 1.5L12 16l-1.5-5.5L5 9l5.5-1.5z"/></svg>
        <div id="sabit-banner-icerik" class="sabit-banner-icerik">
          <span class="sabit-banner-etiket">Sabitlenmiş mesaj</span>
          <span id="sabit-banner-ozet"></span>
        </div>
        <button class="icon-btn" id="sabit-kaldir-btn" title="Sabitlemeyi kaldır">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <div id="mesaj-arama-cubugu" class="mesaj-arama-cubugu gizli">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <input type="text" id="mesaj-arama-input" placeholder="Sohbette ara…" autocomplete="off" />
        <span id="mesaj-arama-sayac" class="mesaj-arama-sayac"></span>
        <button class="icon-btn" id="mesaj-arama-yukari" title="Önceki sonuç">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6"/></svg>
        </button>
        <button class="icon-btn" id="mesaj-arama-asagi" title="Sonraki sonuç">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        </button>
        <button class="icon-btn" id="mesaj-arama-kapat" title="Aramayı kapat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>

      <div id="mesaj-alani" class="mesaj-alani"></div>
      <div id="spam-uyari" class="spam-uyari gizli">Çok hızlı gönderiyorsun — birkaç saniye bekle 🙂</div>
      <div id="yazma-gostergesi" class="yazma-gostergesi"></div>
      <div id="yanitla-bandi" class="yanitla-bandi gizli">
        <div class="yanitla-bandi-icerik">
          <span id="yanitla-bandi-ad"></span>
          <span id="yanitla-bandi-ozet"></span>
        </div>
        <button id="yanitla-iptal-btn" type="button">İptal</button>
      </div>
      <div id="duzenleme-bandi" class="duzenleme-bandi gizli">
        <span>✏️ Mesaj düzenleniyor…</span>
        <button id="duzenleme-iptal-btn" type="button">İptal</button>
      </div>

      <div class="giris-alani" style="position:relative;">
        <div id="bahsetme-listesi" class="bahsetme-listesi gizli"></div>
        <input type="file" id="dosya-input" class="gizli" accept="image/*" />
        <input type="file" id="dosya-input-genel" class="gizli" />

        <div id="ek-menu" class="ek-menu gizli">
          <button id="ek-menu-gorsel" class="ek-menu-ogesi">
            <span class="ek-menu-ikon" style="background:#3F8EDB;"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></span>
            Görsel
          </button>
          <button id="ek-menu-dosya" class="ek-menu-ogesi">
            <span class="ek-menu-ikon" style="background:#7A5FD1;"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg></span>
            Dosya
          </button>
          <button id="ek-menu-konum" class="ek-menu-ogesi">
            <span class="ek-menu-ikon" style="background:#E8A33D;"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg></span>
            Şu anki konumum
          </button>
          <button id="ek-menu-konum-sec" class="ek-menu-ogesi">
            <span class="ek-menu-ikon" style="background:#4C9A6A;"><svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg></span>
            Haritadan konum seç
          </button>
        </div>

        <div id="giris-normal-kontroller" style="display:contents;">
          <button class="ek-btn" id="ek-btn" title="Ekle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <button class="ek-btn" id="emoji-btn" title="Emoji">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><path d="M9 9h.01M15 9h.01"/></svg>
          </button>
          <div id="emoji-panel" class="emoji-panel gizli"></div>
          <textarea id="mesaj-girisi" placeholder="Mesaj yaz..." rows="1"></textarea>
          <button class="ek-btn" id="ses-kayit-btn" title="Sesli mesaj kaydet">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3z"/><path d="M19 10v1a7 7 0 01-14 0v-1M12 18v4M8 22h8"/></svg>
          </button>
          <button class="gonder-btn" id="gonder-btn" title="Gönder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          </button>
        </div>

        <div id="ses-kayit-bandi" class="ses-kayit-bandi gizli">
          <button class="icon-btn" id="ses-kayit-iptal" title="Vazgeç">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
          <span class="ses-kayit-nokta"></span>
          <span id="ses-kayit-sure">0:00</span>
          <span class="ses-kayit-ipucu">Kaydediliyor…</span>
          <button class="gonder-btn" id="ses-kayit-gonder" title="Gönder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          </button>
        </div>
      </div>

      <!-- Konum gönderme paneli — tam ekran değil, sohbet alanının içinde açılır -->
      <div id="konum-panel" class="konum-panel gizli">
        <div class="konum-panel-ust">
          <button id="konum-panel-kapat-btn" class="icon-btn" title="Vazgeç">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="17" height="17"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
          <input type="text" id="konum-sec-arama-input" placeholder="Bir yer, adres ara…" autocomplete="off" />
        </div>
        <div id="konum-sec-sonuclar" class="konum-sec-sonuclar gizli"></div>
        <div class="konum-sec-harita-sarma">
          <div id="konum-sec-harita" class="konum-sec-harita"></div>
          <div class="konum-sec-pin">
            <svg viewBox="0 0 24 24" width="34" height="34"><path fill="#E8A33D" stroke="#8a5a12" stroke-width="1" d="M12 2C8 2 5 5 5 9c0 6 7 13 7 13s7-7 7-13c0-4-3-7-7-7z"/><circle cx="12" cy="9" r="2.6" fill="#fff"/></svg>
          </div>
          <button id="konum-sec-konumum-btn" class="konum-sec-konumum-btn" title="Şu anki konumuma git">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
          </button>
        </div>
        <div class="konum-panel-alt">
          <div id="konum-sec-adres" class="konum-sec-adres">Konumu seçmek için haritayı sürükle…</div>
          <input type="text" id="konum-panel-not" class="konum-panel-not" placeholder="Not ekle (isteğe bağlı)" maxlength="300" autocomplete="off" />
          <button class="btn-ana" id="konum-sec-gonder-btn" style="width:100%;margin-top:10px;">📍 Konumu gönder</button>
        </div>
      </div>

      <!-- Konum görüntüleme paneli — gönderilmiş bir konuma dokununca sohbet alanının içinde açılır -->
      <div id="konum-goruntule-panel" class="konum-panel gizli">
        <div class="konum-panel-ust">
          <div class="konum-panel-baslik">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="17" height="17"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
            Konum
          </div>
          <button id="konum-goruntule-kapat-btn" class="btn-ikincil konum-panel-kapat-metin-btn" title="Kapat">Kapat</button>
        </div>
        <div class="konum-sec-harita-sarma">
          <div id="konum-goruntule-harita" class="konum-sec-harita"></div>
        </div>
        <div class="konum-panel-alt">
          <button class="btn-ana" id="konum-goruntule-yol-tarifi-btn" style="width:100%;">🧭 Yol tarifi al</button>
        </div>
      </div>

      <!-- Canlı buluşma haritası — sohbet alanının içinde açılır, tam ekran değil -->
      <div id="bulusma-katmani" class="bulusma-katmani gizli">
        <!-- Üst şerit: kapat butonu + mesafe kartuşu -->
        <div class="bulusma-ust">
          <button id="bulusma-kapat-btn" class="icon-btn" title="Buluşmayı bitir">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
          <div class="bulusma-mesafe-kartus">
            <span class="bulusma-mesafe-etiket">Aradaki mesafe</span>
            <span class="bulusma-mesafe-deger" id="bulusma-mesafe">—</span>
          </div>
          <div style="width:40px;"></div>
        </div>

        <!-- Harita -->
        <div id="bulusma-harita" class="bulusma-harita"></div>

        <!-- Alt durum şeridi -->
        <div class="bulusma-alt">
          <div class="bulusma-katilimci-seridi" id="bulusma-katilimci-seridi"></div>
          <div class="bulusma-durum-metin" id="bulusma-durum-metin">Konum alınıyor…</div>
        </div>

        <!-- "Buluşma Sağlandı" mührü (yaklaşınca belirir) -->
        <div id="bulusma-saglandi-perde" class="bulusma-saglandi-perde gizli">
          <div class="bulusma-saglandi-muhur">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 12l3 3 5-6"/></svg>
            <div class="bulusma-saglandi-yazi">Buluşma Sağlandı</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<!-- ===================== MODALLAR ===================== -->

<!-- Davetiye oluştur -->
<div id="modal-davet" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3>Aileye yeni üye davet et</h3>
    <p style="color:var(--metin-soluk);font-size:13px;margin-top:-8px;">
      Bu kodu sadece davet etmek istediğin kişiyle paylaş. Kod, hesap oluşturulunca otomatik geçersiz olur.
    </p>
    <div id="davet-kod-cikti"></div>
    <button class="btn-ana" id="davet-kod-uret-btn">Yeni kod oluştur</button>
    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-davet">Kapat</button>
    </div>
  </div>
</div>

<!-- Yeni grup -->
<div id="modal-grup" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3>Yeni grup oluştur</h3>
    <div class="alan">
      <label>Grup adı</label>
      <input type="text" id="grup-ad-input" placeholder="Örn: Aile Sohbeti" />
    </div>
    <label style="font-size:12.5px;color:var(--metin-soluk);">Üyeleri seç</label>
    <div id="grup-uye-secim-listesi" class="uye-secim-listesi"></div>
    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-grup">Vazgeç</button>
      <button class="btn-ana" id="grup-olustur-btn" style="width:auto;">Oluştur</button>
    </div>
  </div>
</div>

<!-- Grup üyeleri görüntüleme / yönetim -->
<div id="modal-grup-uyeler" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3 id="grup-uyeler-baslik">Grup üyeleri</h3>

    <!-- Sadece grup kurucusu görür: ad/fotoğraf düzenleme -->
    <div id="grup-duzenle-alani" class="gizli">
      <div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:16px;">
        <div id="grup-foto-onizleme" class="avatar grup" style="width:72px;height:72px;font-size:26px;">G</div>
        <input type="file" id="grup-foto-input" accept="image/*" class="gizli" />
        <button class="btn-ikincil" id="grup-foto-sec-btn" style="width:auto;">Grup fotoğrafını değiştir</button>
      </div>
      <div class="alan">
        <label>Grup adı</label>
        <input type="text" id="grup-ad-duzenle-input" />
      </div>
      <button class="btn-ana" id="grup-bilgi-kaydet-btn" style="margin-bottom:18px;">Kaydet</button>
    </div>

    <label style="font-size:12.5px;color:var(--metin-soluk);">Üyeler</label>
    <div id="grup-uyeler-listesi" class="uye-secim-listesi"></div>

    <button class="btn-ikincil" id="grup-uye-ekle-ac-btn" style="width:100%;margin-top:10px;">+ Üye ekle</button>
    <div id="grup-uye-ekle-listesi" class="uye-secim-listesi gizli" style="margin-top:8px;"></div>
    <button class="btn-ana gizli" id="grup-uye-ekle-kaydet-btn" style="margin-top:8px;width:auto;">Seçilenleri ekle</button>

    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-grup-uyeler">Kapat</button>
      <button class="btn-ikincil" id="gruptan-ayril-btn" style="width:auto;color:#E5484D;">Gruptan ayrıl</button>
    </div>
  </div>
</div>

<!-- Profilim -->
<div id="modal-profil" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3>Profilim</h3>
    <div style="display:flex;flex-direction:column;align-items:center;gap:10px;margin-bottom:16px;">
      <div id="profil-avatar-onizleme" class="avatar" style="width:84px;height:84px;font-size:30px;">A</div>
      <input type="file" id="profil-foto-input" accept="image/*" class="gizli" />
      <button class="btn-ikincil" id="profil-foto-sec-btn">Profil fotoğrafı değiştir</button>
    </div>
    <div class="alan">
      <label>Adın</label>
      <input type="text" id="profil-ad-input" />
    </div>
    <div class="alan">
      <label>Doğum tarihin</label>
      <input type="date" id="profil-dogum-tarihi-input" />
    </div>
    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-profil">Kapat</button>
      <button class="btn-ana" id="profil-kaydet-btn" style="width:auto;">Kaydet</button>
    </div>

    <hr style="border:none;border-top:1px solid var(--kenar);margin:16px 0 12px;" />
    <p style="font-size:12px;color:var(--metin-soluk);margin-bottom:10px;">Hesap işlemleri</p>
    <div class="profil-menu-liste" style="display:flex;flex-direction:column;gap:8px;">
      <button class="btn-ikincil menu-satiri" id="sifre-degistir-ac-btn"><img class="menu-ikon" src="icons/gradyan/guvenlik.png" alt="" /><span>Şifre değiştir</span></button>
      <button class="btn-ikincil menu-satiri" id="eposta-degistir-ac-btn"><img class="menu-ikon" src="icons/gradyan/duzenleme.png" alt="" /><span>E-posta değiştir</span></button>
      <button class="btn-ikincil menu-satiri" id="bildirim-ayarlari-ac-btn"><img class="menu-ikon" src="icons/gradyan/bildirim.png" alt="" /><span>Bildirim Ayarları</span></button>
      <button class="btn-ikincil menu-satiri" id="konum-izni-ac-btn"><img class="menu-ikon" src="icons/gradyan/konum.png" alt="" /><span>Konum İzni</span></button>
      <button class="btn-ikincil menu-satiri" id="bildirim-izni-ac-btn"><img class="menu-ikon" src="icons/gradyan/bildirim.png" alt="" /><span>Bildirim İzni (Push)</span></button>
      <button class="btn-ikincil menu-satiri" id="acil-ayarlar-ac-btn"><img class="menu-ikon" src="icons/gradyan/acil.png" alt="" /><span>Acil Durum Ayarları</span></button>
      <button class="btn-ikincil menu-satiri" id="yildizli-ac-btn"><img class="menu-ikon" src="icons/gradyan/takvim.png" alt="" /><span>Yıldızlı Mesajlar</span></button>
      <button class="btn-ikincil menu-satiri" id="tema-secici-ac-btn"><img class="menu-ikon" src="icons/gradyan/ayarlar.png" alt="" /><span>Tema Seçimi</span></button>
      <button class="btn-ikincil menu-satiri" id="yedekleme-ac-btn"><img class="menu-ikon" src="icons/gradyan/arsiv.png" alt="" /><span>Yedekleme ve Geri Yükleme</span></button>
      <button class="btn-ikincil menu-satiri" id="hesap-sil-ac-btn" style="color:#E5484D;"><span style="width:26px;text-align:center;">🗑️</span><span>Hesabı kalıcı olarak sil</span></button>
    </div>
  </div>
</div>

<!-- Şifre değiştir -->
<div id="modal-sifre-degistir" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3>🔑 Şifre değiştir</h3>
    <div class="alan">
      <label>Mevcut şifren</label>
      <input type="password" id="sifre-mevcut" autocomplete="current-password" placeholder="••••••••" />
    </div>
    <div class="alan">
      <label>Yeni şifre</label>
      <input type="password" id="sifre-yeni" autocomplete="new-password" placeholder="En az 6 karakter" />
    </div>
    <div class="alan">
      <label>Yeni şifre (tekrar)</label>
      <input type="password" id="sifre-yeni-tekrar" autocomplete="new-password" placeholder="••••••••" />
    </div>
    <div id="sifre-degistir-hata" class="auth-hata-metin gizli"></div>
    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-sifre-degistir">Vazgeç</button>
      <button class="btn-ana" id="sifre-degistir-btn" style="width:auto;">Değiştir</button>
    </div>
  </div>
</div>

<!-- E-posta değiştir -->
<div id="modal-eposta-degistir" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3>✉️ E-posta değiştir</h3>
    <p style="font-size:12.5px;color:var(--metin-soluk);margin-bottom:12px;">Mevcut e-posta: <strong id="eposta-mevcut-goster"></strong></p>
    <div class="alan">
      <label>Yeni e-posta adresi</label>
      <input type="email" id="eposta-yeni" autocomplete="email" placeholder="yeni@ornek.com" />
    </div>
    <div class="alan">
      <label>Mevcut şifren (doğrulama için)</label>
      <input type="password" id="eposta-sifre" autocomplete="current-password" placeholder="••••••••" />
    </div>
    <div id="eposta-degistir-hata" class="auth-hata-metin gizli"></div>
    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-eposta-degistir">Vazgeç</button>
      <button class="btn-ana" id="eposta-degistir-btn" style="width:auto;">Değiştir</button>
    </div>
  </div>
</div>

<!-- Hesabı sil -->
<div id="modal-hesap-sil" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3 style="color:#E5484D;">⚠️ Hesabı kalıcı olarak sil</h3>
    <p style="font-size:13px;color:var(--metin-soluk);margin-bottom:14px;line-height:1.5;">
      Bu işlem <strong>geri alınamaz</strong>. Profilin silinir, sohbetlerden adın kalkar.
      Gönderdiğin mesajlar sohbetlerde "silindi" olarak görünür.
    </p>
    <div class="alan">
      <label>Mevcut şifren (onay için)</label>
      <input type="password" id="hesap-sil-sifre" autocomplete="current-password" placeholder="••••••••" />
    </div>
    <div id="hesap-sil-hata" class="auth-hata-metin gizli"></div>
    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-hesap-sil">Vazgeç</button>
      <button class="btn-ana" id="hesap-sil-btn" style="width:auto;background:#E5484D;">Hesabı sil</button>
    </div>
  </div>
</div>

<!-- ===================== TEMA SEÇİCİ ===================== -->
<div id="modal-tema-secici" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3>🎨 Tema Seçimi</h3>
    <p style="font-size:13px;color:var(--metin-soluk);margin-bottom:16px;line-height:1.5;">
      Uygulamanın atmosferini seç. Her tema aynı sıcaklığın koyu ve açık tonlarını sunar.
    </p>
    <div class="tema-secim-izgara">
      <button class="tema-secim-kart" data-tema="yesil">
        <div class="tema-onizleme" style="background:#0E1613;">
          <span class="tema-swatch" style="background:#16211C;"></span>
          <span class="tema-swatch" style="background:#17B978;"></span>
          <span class="tema-swatch" style="background:#22D3A8;"></span>
          <span class="tema-swatch" style="background:#FFD24D;"></span>
        </div>
        <span class="tema-ad">Kakule</span>
        <span class="tema-alt">Marka yeşili</span>
      </button>

      <button class="tema-secim-kart" data-tema="yesil-acik">
        <div class="tema-onizleme" style="background:#F0F5F2;">
          <span class="tema-swatch" style="background:#FFFFFF;"></span>
          <span class="tema-swatch" style="background:#17B978;"></span>
          <span class="tema-swatch" style="background:#D4F0E4;"></span>
          <span class="tema-swatch" style="background:#FFD24D;"></span>
        </div>
        <span class="tema-ad">Kakule Açık</span>
        <span class="tema-alt">Taze mint</span>
      </button>

      <button class="tema-secim-kart" data-tema="bohem">
        <div class="tema-onizleme" style="background:#241C15;">
          <span class="tema-swatch" style="background:#322619;"></span>
          <span class="tema-swatch" style="background:#C87941;"></span>
          <span class="tema-swatch" style="background:#5A3E28;"></span>
          <span class="tema-swatch" style="background:#F2E9DC;"></span>
        </div>
        <span class="tema-ad">Bohem</span>
        <span class="tema-alt">Sıcak espresso</span>
      </button>

      <button class="tema-secim-kart" data-tema="bohem-acik">
        <div class="tema-onizleme" style="background:#EDE4D3;">
          <span class="tema-swatch" style="background:#FBF6EC;"></span>
          <span class="tema-swatch" style="background:#B4652F;"></span>
          <span class="tema-swatch" style="background:#E0CDB2;"></span>
          <span class="tema-swatch" style="background:#3A2A1C;"></span>
        </div>
        <span class="tema-ad">Bohem Açık</span>
        <span class="tema-alt">Aged parchment</span>
      </button>

      <button class="tema-secim-kart" data-tema="koyu">
        <div class="tema-onizleme" style="background:#14171C;">
          <span class="tema-swatch" style="background:#1C2128;"></span>
          <span class="tema-swatch" style="background:#E8A33D;"></span>
          <span class="tema-swatch" style="background:#2E5F58;"></span>
          <span class="tema-swatch" style="background:#EDEEF0;"></span>
        </div>
        <span class="tema-ad">Gece</span>
        <span class="tema-alt">Klasik koyu</span>
      </button>

      <button class="tema-secim-kart" data-tema="acik">
        <div class="tema-onizleme" style="background:#F4F1EA;">
          <span class="tema-swatch" style="background:#FFFFFF;"></span>
          <span class="tema-swatch" style="background:#C9842A;"></span>
          <span class="tema-swatch" style="background:#DCEDE7;"></span>
          <span class="tema-swatch" style="background:#20232A;"></span>
        </div>
        <span class="tema-ad">Gündüz</span>
        <span class="tema-alt">Klasik açık</span>
      </button>
    </div>
    <div class="modal-kapat-cubuk" style="justify-content:center;">
      <button class="btn-ikincil modal-kapat" data-modal="modal-tema-secici">Kapat</button>
    </div>
  </div>
</div>

<!-- ===================== YEDEKLEME VE GERİ YÜKLEME ===================== -->
<div id="modal-yedekleme" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3 class="baslik-ikonlu"><img class="baslik-ikon" src="icons/gradyan/dosyalar.png" alt="" /> Yedekleme ve Geri Yükleme</h3>
    <p style="font-size:13px;color:var(--metin-soluk);margin-bottom:14px;line-height:1.5;">
      Üyesi olduğun tüm sohbetleri, mesajları ve medyayı tek bir <strong>.zip</strong>
      dosyası olarak indirebilirsin. Bu dosyayı Google Drive'a, e-postana veya güvenli
      bir yere saklayıp istediğin zaman geri açabilir, farklı bir cihazda okuyabilirsin.
    </p>

    <div style="display:flex;flex-direction:column;gap:8px;">
      <button class="btn-ana" id="yedek-olustur-btn" style="width:100%;">📦 Yedek oluştur ve indir</button>
      <label style="font-size:12.5px;display:flex;align-items:center;gap:8px;color:var(--metin-soluk);cursor:pointer;padding:4px 2px;">
        <input type="checkbox" id="yedek-medya-dahil" checked style="width:auto;" />
        Medyayı da (fotoğraf/ses/dosya) pakete dahil et — daha büyük dosya
      </label>
    </div>

    <div id="yedek-ilerleme" class="gizli" style="margin-top:14px;">
      <div style="height:8px;background:var(--kenar);border-radius:99px;overflow:hidden;">
        <div id="yedek-ilerleme-cubuk" style="height:100%;width:0%;background:var(--alev);transition:width .25s;"></div>
      </div>
      <p id="yedek-ilerleme-metin" style="font-size:12px;color:var(--metin-soluk);margin-top:6px;text-align:center;">Hazırlanıyor…</p>
    </div>

    <hr style="border:none;border-top:1px solid var(--kenar);margin:18px 0 14px;" />

    <p style="font-size:12px;color:var(--metin-soluk);margin-bottom:10px;">Bir yedeği geri yükle / görüntüle</p>
    <p style="font-size:12.5px;color:var(--metin-soluk);margin-bottom:10px;line-height:1.5;">
      Daha önce oluşturduğun bir <strong>.zip</strong> yedeği seç; içeriğini okuma modunda
      (salt-okunur arşiv görüntüleyici) açar. Sohbetlerin zaten bulutta durduğu için yeni
      telefonda giriş yapman geçmişi otomatik getirir; bu görüntüleyici, silinmiş ya da
      arşivlenmiş bir kopyayı okumak içindir.
    </p>
    <input type="file" id="yedek-geri-yukle-input" accept=".zip,application/zip" class="gizli" />
    <button class="btn-ikincil" id="yedek-geri-yukle-btn" style="width:100%;">📂 Yedek dosyası seç ve aç</button>

    <div class="modal-kapat-cubuk" style="margin-top:16px;">
      <button class="btn-ikincil modal-kapat" data-modal="modal-yedekleme">Kapat</button>
    </div>
  </div>
</div>

<!-- Arşiv görüntüleyici (geri yüklenen yedeği salt-okunur gösterir) -->
<div id="arsiv-katmani" class="arsiv-katmani gizli">
  <div class="arsiv-ust">
    <button id="arsiv-geri-btn" class="icon-btn" title="Kapat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
    </button>
    <div class="arsiv-baslik">
      <strong id="arsiv-baslik-metin">Arşiv</strong>
      <span id="arsiv-alt-metin" style="font-size:12px;color:var(--metin-soluk);"></span>
    </div>
  </div>
  <div class="arsiv-govde">
    <div id="arsiv-sohbet-listesi" class="arsiv-sohbet-listesi"></div>
    <div id="arsiv-mesaj-alani" class="arsiv-mesaj-alani">
      <div class="arsiv-bos">Soldan bir sohbet seç</div>
    </div>
  </div>
</div>

<!-- ===================== BİLDİRİM AYARLARI ===================== -->
<div id="modal-bildirim-ayarlari" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3>🔔 Bildirim Ayarları</h3>

    <label class="anahtar-satir" for="bildirim-ses-acik-girdi">
      <div class="anahtar-metin">
        <div class="anahtar-baslik">Bildirim sesi</div>
        <div class="anahtar-aciklama">Yeni mesaj geldiğinde uygulama açıkken ses çalsın.</div>
      </div>
      <span class="anahtar">
        <input type="checkbox" id="bildirim-ses-acik-girdi" checked />
        <span class="anahtar-slider"></span>
      </span>
    </label>

    <div class="alan" style="margin-top:6px;">
      <label>Bildirim sesi seç</label>
      <div id="ses-secim-listesi" class="ses-secim-listesi">
        <label class="ses-secim-ogesi">
          <input type="radio" name="ses-secimi" value="ting" checked />
          <span class="ad-kutu">Tıng</span>
          <button type="button" class="ses-onizle-btn" data-ses="ting" title="Dinle">▶</button>
        </label>
        <label class="ses-secim-ogesi">
          <input type="radio" name="ses-secimi" value="pop" />
          <span class="ad-kutu">Pop</span>
          <button type="button" class="ses-onizle-btn" data-ses="pop" title="Dinle">▶</button>
        </label>
        <label class="ses-secim-ogesi">
          <input type="radio" name="ses-secimi" value="zil" />
          <span class="ad-kutu">Zil</span>
          <button type="button" class="ses-onizle-btn" data-ses="zil" title="Dinle">▶</button>
        </label>
        <label class="ses-secim-ogesi">
          <input type="radio" name="ses-secimi" value="yumusak" />
          <span class="ad-kutu">Yumuşak</span>
          <button type="button" class="ses-onizle-btn" data-ses="yumusak" title="Dinle">▶</button>
        </label>
      </div>
    </div>

    <hr style="border:none;border-top:1px solid var(--kenar);margin:14px 0 4px;" />

    <label class="anahtar-satir" for="uygulama-sessiz-girdi">
      <div class="anahtar-metin">
        <div class="anahtar-baslik">Uygulamayı tamamen sessize al</div>
        <div class="anahtar-aciklama">Açıkken hiçbir sohbetten ses veya bildirim gelmez. 🆘 Acil durum (SOS) bildirimleri bu ayarı atlar.</div>
      </div>
      <span class="anahtar">
        <input type="checkbox" id="uygulama-sessiz-girdi" />
        <span class="anahtar-slider"></span>
      </span>
    </label>

    <hr style="border:none;border-top:1px solid var(--kenar);margin:14px 0 4px;" />

    <label class="anahtar-satir" for="gunluk-ozet-girdi">
      <div class="anahtar-metin">
        <div class="anahtar-baslik">Günlük sabah özeti</div>
        <div class="anahtar-aciklama">Her sabah 09:00'da hava durumu, güncel döviz/altın kuru, günün gündemi ve günün sözünü içeren tek bir bildirim gönderilsin.</div>
      </div>
      <span class="anahtar">
        <input type="checkbox" id="gunluk-ozet-girdi" checked />
        <span class="anahtar-slider"></span>
      </span>
    </label>

    <hr style="border:none;border-top:1px solid var(--kenar);margin:14px 0 4px;" />

    <label class="anahtar-satir" for="cevrimici-gizle-girdi">
      <div class="anahtar-metin">
        <div class="anahtar-baslik">Çevrimiçi durumumu gizle</div>
        <div class="anahtar-aciklama">Açarsan diğer aile üyeleri "Çevrimiçi" durumunu ve "Son görülme" bilgini göremez. Sen onlarınkini görmeye devam edersin.</div>
      </div>
      <span class="anahtar">
        <input type="checkbox" id="cevrimici-gizle-girdi" />
        <span class="anahtar-slider"></span>
      </span>
    </label>

    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-bildirim-ayarlari">Kapat</button>
      <button class="btn-ana" id="bildirim-ayarlari-kaydet-btn" style="width:auto;">Kaydet</button>
    </div>
  </div>
</div>

<!-- ===================== ACİL DURUM (SOS) AYARLARI ===================== -->
<div id="modal-acil-ayarlar" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3>🆘 Acil Durum Ayarları</h3>
    <p style="font-size:12.5px;color:var(--metin-soluk);margin:-10px 0 14px;line-height:1.5;">
      SOS butonuna bastığında, seçtiğin kişilere aşağıdaki mesaj ve o anki konumun otomatik olarak gönderilir.
    </p>
    <div class="alan">
      <label>Acil durum bilgin (kan grubu, alerjiler, kronik rahatsızlık, kullandığın ilaçlar, doktorun vb. — isteğe bağlı)</label>
      <textarea id="acil-bilgi-input" rows="3" placeholder="Örn: Kan grubu 0 Rh+, penisilin alerjisi, tansiyon ilacı kullanıyorum."></textarea>
    </div>
    <div class="alan">
      <label>SOS butonuna basınca gönderilecek mesaj</label>
      <textarea id="acil-mesaj-input" rows="2" placeholder="🆘 Acil durumdayım, yardıma ihtiyacım var!"></textarea>
    </div>
    <div class="alan" style="margin-bottom:6px;">
      <label>Kime gönderilsin?</label>
    </div>
    <div id="acil-alici-secim-listesi" class="uye-secim-listesi"></div>
    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-acil-ayarlar">Kapat</button>
      <button class="btn-ana" id="acil-ayarlar-kaydet-btn" style="width:auto;">Kaydet</button>
    </div>
  </div>
</div>

<!-- ===================== ACİL DURUM (SOS) ONAY ===================== -->
<div id="modal-acil-onay" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3 style="color:var(--acil);">🆘 Acil Durum Bildirimi</h3>
    <div id="acil-onay-icerik"></div>
    <p style="font-size:12px;color:var(--metin-soluk);margin-top:4px;">📍 Anlık konumun da otomatik olarak paylaşılacak.</p>
    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-acil-onay">Vazgeç</button>
      <button class="btn-ana" id="acil-onay-gonder-btn" style="width:auto;background:var(--acil);color:#fff;">Evet, Gönder</button>
    </div>
  </div>
</div>

<!-- ===================== ADMİN PANELİ ===================== -->
<div id="modal-admin" class="modal-perde gizli">
  <div class="modal-kutu" style="max-width:520px;max-height:85vh;display:flex;flex-direction:column;">
    <h3 style="flex-shrink:0;">⚙️ Admin Paneli</h3>

    <!-- Sekmeler -->
    <div style="display:flex;gap:8px;margin-bottom:14px;flex-shrink:0;">
      <button id="admin-sekme-uyeler" class="sekme aktif" style="flex:1;">👥 Üyeler</button>
      <button id="admin-sekme-davetler" class="sekme" style="flex:1;">📨 Davetler</button>
    </div>

    <!-- Üyeler alanı -->
    <div id="admin-alan-uyeler" style="overflow-y:auto;flex:1;">
      <div id="admin-uyeler-listesi"></div>
    </div>

    <!-- Davetler alanı -->
    <div id="admin-alan-davetler" class="gizli" style="overflow-y:auto;flex:1;">
      <button class="btn-ana" id="admin-yeni-davet-btn" style="margin-bottom:4px;">+ Yeni Davetiye Oluştur</button>
      <div id="admin-davet-uretilen" class="gizli"></div>
      <div id="admin-davetler-listesi" style="margin-top:8px;"></div>
    </div>

    <div class="modal-kapat-cubuk" style="flex-shrink:0;margin-top:12px;">
      <button class="btn-ikincil modal-kapat" data-modal="modal-admin">Kapat</button>
    </div>
  </div>
</div>

<!-- Statüs ekle -->
<div id="modal-statu-ekle" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3>Statüs ekle</h3>
    <p style="color:var(--metin-soluk);font-size:13px;margin-top:-8px;">24 saat sonra otomatik kaybolur.</p>
    <div id="statu-ekle-onizleme" style="margin-bottom:12px;"></div>
    <input type="file" id="statu-foto-input" accept="image/*" class="gizli" />
    <button class="btn-ikincil" id="statu-foto-sec-btn" style="width:100%;margin-bottom:10px;">📷 Fotoğraf seç</button>
    <div class="alan">
      <label>Metin (fotoğrafsız da gönderebilirsin)</label>
      <input type="text" id="statu-metin-input" placeholder="Ne düşünüyorsun?" />
    </div>
    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-statu-ekle">Vazgeç</button>
      <button class="btn-ana" id="statu-paylas-btn" style="width:auto;">Paylaş</button>
    </div>
  </div>
</div>

<!-- Statüs görüntüleyici -->
<div id="statu-goruntuleyici" class="statu-goruntuleyici gizli">
  <div class="statu-ust-cubuk">
    <div class="statu-ilerleme-iz" id="statu-ilerleme-iz"></div>
  </div>
  <div class="statu-baslik-satiri">
    <div class="avatar" id="statu-gor-avatar" style="width:36px;height:36px;font-size:14px;">A</div>
    <div style="flex:1;">
      <div style="font-weight:600;font-size:13.5px;" id="statu-gor-ad">—</div>
      <div style="font-size:11.5px;color:var(--metin-soluk);" id="statu-gor-zaman">—</div>
    </div>
    <button class="icon-btn" id="statu-kapat-btn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
  </div>
  <div class="statu-icerik-alani" id="statu-icerik-alani"></div>
  <div class="statu-tiklama-alani">
    <div id="statu-onceki" class="statu-tikla-yarisi"></div>
    <div id="statu-sonraki" class="statu-tikla-yarisi"></div>
  </div>
  <div class="statu-yanit-cubugu" id="statu-yanit-cubugu">
    <div class="statu-tepki-satiri" id="statu-tepki-satiri">
      <button type="button" class="statu-tepki-btn" data-emoji="❤️">❤️</button>
      <button type="button" class="statu-tepki-btn" data-emoji="😂">😂</button>
      <button type="button" class="statu-tepki-btn" data-emoji="😮">😮</button>
      <button type="button" class="statu-tepki-btn" data-emoji="😢">😢</button>
      <button type="button" class="statu-tepki-btn" data-emoji="👏">👏</button>
      <button type="button" class="statu-tepki-btn" data-emoji="🙏">🙏</button>
      <button type="button" class="statu-tepki-btn" data-emoji="🔥">🔥</button>
    </div>
    <div class="statu-yanit-giris-satiri">
      <input type="text" id="statu-yanit-input" placeholder="Yanıt yaz..." maxlength="500" />
      <button class="gonder-btn" id="statu-yanit-gonder-btn" title="Gönder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>
      </button>
    </div>
  </div>
  <div class="statu-kendi-bilgi-cubugu gizli" id="statu-kendi-bilgi-cubugu">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
    <span id="statu-gorenler-sayisi">0 kişi gördü</span>
  </div>
</div>

<!-- Görsel / dosya önizleme (göndermeden önce) -->
<div id="modal-onizleme" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3 id="onizleme-baslik">Gönder</h3>
    <div id="onizleme-icerik" style="margin-bottom:14px;"></div>
    <div class="alan">
      <input type="text" id="onizleme-aciklama" placeholder="Açıklama ekle (isteğe bağlı)" />
    </div>
    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-onizleme">Vazgeç</button>
      <button class="btn-ana" id="onizleme-gonder-btn" style="width:auto;">Gönder</button>
    </div>
  </div>
</div>

<!-- Medya galerisi: sohbette gönderilmiş tüm görseller -->
<div id="modal-medya-galeri" class="modal-perde gizli">
  <div class="modal-kutu medya-galeri-kutu">
    <h3 class="baslik-ikonlu"><img class="baslik-ikon" src="icons/gradyan/gorsel.png" alt="" /> Medya galerisi</h3>
    <div id="medya-galeri-izgara" class="medya-galeri-izgara"></div>
    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-medya-galeri">Kapat</button>
    </div>
  </div>
</div>

<!-- Medya galerisinden tam ekran görsel önizleme (ileri/geri gezinme) -->
<div id="medya-lightbox" class="medya-lightbox gizli">
  <button id="medya-lightbox-kapat" class="medya-lightbox-btn medya-lightbox-kapat" title="Kapat">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
  </button>
  <button id="medya-lightbox-onceki" class="medya-lightbox-btn medya-lightbox-ok medya-lightbox-ok-sol" title="Önceki">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
  </button>
  <img id="medya-lightbox-img" src="" alt="" />
  <button id="medya-lightbox-sonraki" class="medya-lightbox-btn medya-lightbox-ok medya-lightbox-ok-sag" title="Sonraki">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
  </button>
  <div id="medya-lightbox-sayac" class="medya-lightbox-sayac"></div>
</div>

<!-- Mesaj iletme: hedef sohbet(ler) seç -->
<div id="modal-mesaj-ilet" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3>Mesajı ilet</h3>
    <p style="color:var(--metin-soluk);font-size:13px;margin-top:-8px;">
      İletilecek sohbet(ler)i seç.
    </p>
    <div id="ilet-sohbet-secim-listesi" class="uye-secim-listesi"></div>
    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-mesaj-ilet">Vazgeç</button>
      <button class="btn-ana" id="mesaj-ilet-gonder-btn" style="width:auto;">İlet</button>
    </div>
  </div>
</div>

<!-- Mesaj işlemleri (düzenle/sil) -->
<div id="modal-mesaj-aksiyon" class="modal-perde gizli">
  <div class="modal-kutu" style="max-width:300px;">
    <h3>Mesaj</h3>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <button class="btn-ikincil" id="mesaj-yanitla-btn" style="width:100%;">↩️ Yanıtla</button>
      <button class="btn-ikincil" id="mesaj-yildizla-btn" style="width:100%;">⭐ Yıldızla</button>
      <button class="btn-ikincil" id="mesaj-sabitle-btn" style="width:100%;">📌 Sabitle</button>
      <button class="btn-ikincil" id="mesaj-ilet-btn" style="width:100%;">📤 İlet</button>
      <button class="btn-ikincil" id="mesaj-duzenle-btn" style="width:100%;">✏️ Düzenle</button>
      <button class="btn-ikincil" id="mesaj-sil-btn" style="width:100%;color:#E5484D;">🗑️ Sil</button>
      <button class="btn-ikincil modal-kapat" data-modal="modal-mesaj-aksiyon" style="width:100%;">Vazgeç</button>
    </div>
  </div>
</div>

<!-- Sohbet yönetim menüsü (uzun basma) -->
<div id="modal-sohbet-yonetim" class="modal-perde gizli">
  <div class="modal-kutu" style="max-width:300px;">
    <h3>Sohbet</h3>
    <div style="display:flex;flex-direction:column;gap:8px;">
      <button class="btn-ikincil" id="sohbet-yonetim-sabitle" style="width:100%;">📌 Sabitle</button>
      <button class="btn-ikincil" id="sohbet-yonetim-sessize" style="width:100%;">🔕 Sessize al</button>
      <button class="btn-ikincil" id="sohbet-yonetim-medya" style="width:100%;">🖼️ Medya ve dosyalar</button>
      <button class="btn-ikincil" id="sohbet-yonetim-sil" style="width:100%;color:#d33;">🗑️ Sohbeti sil</button>
      <button class="btn-ikincil modal-kapat" data-modal="modal-sohbet-yonetim" style="width:100%;">Vazgeç</button>
    </div>
  </div>
</div>

<!-- Yıldızlı mesajlar (favoriler) -->
<div id="modal-yildizli" class="modal-perde gizli">
  <div class="modal-kutu" style="max-width:440px;">
    <h3>⭐ Yıldızlı Mesajlar</h3>
    <div id="yildizli-icerik" class="yildizli-liste"></div>
    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-yildizli">Kapat</button>
    </div>
  </div>
</div>

<!-- ===================== ARAMA KATMANI ===================== -->
<div id="arama-katmani" class="arama-katmani gizli">
  <video id="uzak-video" autoplay playsinline class="gizli"></video>
  <!-- Uzak taraf kamerayı kapattığında (veya henüz video gelmediğinde) donmuş
       kare yerine karşı tarafın avatarını gösteren katman. -->
  <div id="uzak-avatar" class="uzak-avatar gizli"></div>
  <video id="yerel-video" autoplay playsinline muted class="gizli"></video>
  <div class="arama-bilgi">
    <div class="avatar" id="arama-avatar">A</div>
    <div class="ad" id="arama-ad">—</div>
    <div class="durum" id="arama-durum">Aranıyor...</div>
  </div>
  <div class="arama-kontrol">
    <button id="arama-mikrofon-btn" title="Mikrofon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/><path d="M19 10v2a7 7 0 01-14 0v-2M12 19v3"/></svg>
    </button>
    <button id="arama-kamera-btn" title="Kamera">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
    </button>
    <button class="kapat-btn" id="arama-kapat-btn" title="Kapat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
    </button>
  </div>
</div>

<!-- Gelen arama bildirimi -->
<div id="gelen-arama-bildirimi" class="gelen-arama-bildirimi gizli">
  <div class="gelen-arama-avatar-sarma">
    <div class="avatar" id="gelen-arama-avatar">A</div>
    <img class="gelen-arama-tip-rozet" src="icons/gradyan/sesliarama.png" alt="" />
  </div>
  <div>
    <div style="font-weight:600;" id="gelen-arama-ad">—</div>
    <div style="font-size:12px;color:var(--metin-soluk);" id="gelen-arama-tip">Sesli arama</div>
  </div>
  <button class="kabul" id="arama-kabul-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
  </button>
  <button class="red" id="arama-red-btn">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
  </button>
</div>

<!-- ===================== BULUŞMA ===================== -->

<!-- Davet mührü kartı: "Buluşma" başlatılırken açılır -->
<div id="modal-bulusma-davet" class="modal-perde gizli">
  <div class="modal-kutu bulusma-davet-kutu">
    <div class="bulusma-muhur">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
    </div>
    <h3 style="text-align:center;">Buluşma</h3>
    <p style="font-size:13.5px;color:var(--metin-soluk);text-align:center;line-height:1.55;margin-bottom:16px;">
      Karşı tarafa bir buluşma çağrısı gönderilecek. Kabul edenler haritada canlı olarak
      belirir; birbirinize yaklaştıkça aradaki mesafe erir. Konumun yalnızca bu ekran
      açıkken paylaşılır — kapattığında paylaşım anında durur.
    </p>
    <div class="modal-kapat-cubuk" style="justify-content:center;">
      <button class="btn-ikincil modal-kapat" data-modal="modal-bulusma-davet">Vazgeç</button>
      <button class="btn-ana" id="bulusma-baslat-onay-btn" style="width:auto;">Çağrıyı gönder</button>
    </div>
  </div>
</div>

<!-- Gelen buluşma daveti bildirimi -->
<div id="gelen-bulusma-bildirimi" class="gelen-arama-bildirimi gizli">
  <div class="bulusma-bildirim-ikon">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/></svg>
  </div>
  <div>
    <div style="font-weight:600;" id="gelen-bulusma-ad">—</div>
    <div style="font-size:12px;color:var(--metin-soluk);">Buluşmaya çağırıyor</div>
  </div>
  <button class="kabul" id="bulusma-kabul-btn" title="Katıl">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
  </button>
  <button class="red" id="bulusma-red-btn" title="Reddet">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
  </button>
</div>

<!-- ===================== DEFTER — Paylaşılan Yapılacaklar ===================== -->

<!-- Yeni liste oluştur -->
<div id="modal-liste-olustur" class="modal-perde gizli">
  <div class="modal-kutu">
    <h3>📜 Yeni Liste</h3>
    <div class="alan">
      <label>Liste adı</label>
      <input type="text" id="liste-ad-input" placeholder="Örn: Market, Ev İşleri, Tatil Hazırlığı" maxlength="60" />
    </div>
    <div class="alan">
      <label>Kimlerle paylaşılsın?</label>
      <div class="liste-kaynak-secim">
        <button class="liste-kaynak-btn aktif" data-kaynak="kisi">Kişileri seç</button>
        <button class="liste-kaynak-btn" data-kaynak="sohbet">Bir sohbetten al</button>
      </div>
    </div>
    <div id="liste-kisi-secim-alani">
      <div id="liste-uye-secim-listesi" class="uye-secim-listesi"></div>
    </div>
    <div id="liste-sohbet-secim-alani" class="gizli">
      <div id="liste-sohbet-secim-listesi" class="uye-secim-listesi"></div>
    </div>
    <div class="modal-kapat-cubuk">
      <button class="btn-ikincil modal-kapat" data-modal="modal-liste-olustur">Vazgeç</button>
      <button class="btn-ana" id="liste-olustur-btn" style="width:auto;">Oluştur</button>
    </div>
  </div>
</div>

<!-- Tam ekran liste görünümü -->
<div id="liste-katmani" class="liste-katmani gizli">
  <div class="liste-ust">
    <button id="liste-geri-btn" class="icon-btn" title="Geri">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
    </button>
    <div class="liste-baslik-alan">
      <strong id="liste-baslik-metin">Liste</strong>
      <span id="liste-alt-metin"></span>
    </div>
    <button id="liste-sil-btn" class="icon-btn" title="Listeyi sil">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6"/></svg>
    </button>
  </div>

  <div class="liste-filtre-cubuk">
    <button class="liste-filtre aktif" data-filtre="tumu">Tümü</button>
    <button class="liste-filtre" data-filtre="bekleyen">Bekleyen</button>
    <button class="liste-filtre" data-filtre="biten">Tamamlanan</button>
  </div>

  <div id="liste-gorev-alani" class="liste-gorev-alani"></div>

  <!-- Görev ekleme çubuğu -->
  <div class="liste-ekle-cubuk">
    <div class="liste-ekle-satir">
      <input type="text" id="gorev-metin-input" placeholder="Yapılacak bir şey ekle…" maxlength="200" />
      <button id="gorev-tarih-toggle" class="icon-btn" title="Tarih/saat ekle">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
      </button>
      <button id="gorev-ekle-btn" class="btn-ana" style="width:auto;padding:0 18px;">Ekle</button>
    </div>
    <input type="datetime-local" id="gorev-tarih-input" class="gizli" />
  </div>
</div>

<!-- ===================== URL PARAMETRESİNDEN DAVETİYE KODU OTO-DOLDUR ===================== -->
<script>
  (function () {
    try {
      const params = new URLSearchParams(window.location.search);
      const d = params.get("d");
      if (!d) return;
      // Sayfa yüklenince formu aç ve kodu doldur
      window.addEventListener("DOMContentLoaded", function () {
        const davetInput = document.getElementById("kayit-davet-kodu");
        const davetAciklama = document.getElementById("davet-kodu-aciklama");
        const kayitForm = document.getElementById("kayit-form");
        const girisForm = document.getElementById("giris-form");
        const kayitAc = document.getElementById("kayit-ekrani-ac");
        const girisAc = document.getElementById("giris-ekrani-ac");
        const sifremiUnuttum = document.getElementById("sifremi-unuttum-ac");
        if (!davetInput || !kayitForm) return;

        // Kayıt formunu aç
        girisForm && girisForm.classList.add("gizli");
        kayitForm.classList.remove("gizli");
        kayitAc && kayitAc.classList.add("gizli");
        girisAc && girisAc.classList.remove("gizli");
        sifremiUnuttum && sifremiUnuttum.classList.add("gizli");

        // Kodu doldur ve kilitle
        davetInput.value = d.toUpperCase();
        davetInput.readOnly = true;
        davetInput.style.opacity = "0.7";
        davetAciklama && davetAciklama.classList.remove("gizli");

        // URL'den kodu temizle (güvenlik — sayfa yenilenince tekrar dolmasın)
        const temizUrl = window.location.pathname + (window.location.hash || "");
        window.history.replaceState({}, "", temizUrl);
      });
    } catch (e) {}
  })();
</script>

<!-- ===================== HOŞ GELDİN ONBOARDING ===================== -->
<div id="onboarding-overlay" class="onboarding-overlay gizli">
  <div class="onboarding-kart">
    <button id="onboarding-atla-btn" class="onboarding-atla">Atla</button>

    <div id="onboarding-svg" class="onboarding-svg"></div>
    <h2 id="onboarding-baslik" class="onboarding-baslik"></h2>
    <p id="onboarding-aciklama" class="onboarding-aciklama"></p>

    <div id="onboarding-noktalar" class="onboarding-noktalar"></div>

    <div class="onboarding-butonlar">
      <button id="onboarding-geri-btn" class="btn-ikincil" style="width:auto;min-width:80px;">← Geri</button>
      <button id="onboarding-ileri-btn" class="btn-ana" style="width:auto;min-width:110px;">İleri →</button>
    </div>
  </div>
</div>

<!-- ===================== FIREBASE SDK (CDN, modüler v10) ===================== -->
<script type="module" src="app.js"></script>
</body>
</html>
