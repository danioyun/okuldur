'use strict';

require('dotenv').config();

const express      = require('express');
const path         = require('path');
const { v4: uuidv4, validate: uuidValidate } = require('uuid');
const PDFDocument  = require('pdfkit');
const rateLimit    = require('express-rate-limit');
const helmet       = require('helmet');
const session      = require('express-session');
const mongoose     = require('mongoose');
const cloudinary   = require('cloudinary').v2;
const adresData    = require('./adresData');

const app  = express();
const PORT = process.env.PORT || 3000;

// ────────────────────────────────────────────────
// Sabitler
// ────────────────────────────────────────────────
const SINAV_TARIHI = '17 Mayıs 2026';
const SINAV_SAATI  = '10:00';
const SINAV_YERI   = 'Prof. Dr. Necmettin Erbakan İmam Hatip Ortaokulu – Ana Sınav Salonu';

// ────────────────────────────────────────────────
// MongoDB — isteğe bağlı, bağlanamazsa bellekte çalışır
// ────────────────────────────────────────────────
let mongoConnected = false;
const MONGO_URI = process.env.MONGODB_URI || '';

if (MONGO_URI && !MONGO_URI.includes('KULLANICI')) {
  mongoose.connect(MONGO_URI)
    .then(() => { mongoConnected = true; console.log('[MongoDB] Bağlantı başarılı'); })
    .catch(e  => console.warn('[MongoDB] Bağlanamadı, bellekte çalışılıyor:', e.message));
} else {
  console.warn('[MongoDB] URI ayarlanmamış — veriler bellekte tutulacak.');
}

// ────────────────────────────────────────────────
// MongoDB Şeması
// ────────────────────────────────────────────────
const KayitSchema = new mongoose.Schema({
  id:                { type: String, required: true, unique: true, index: true },
  kayitNo:           String, ad: String, soyad: String, tc: String,
  dogum_tarihi:      String, dogumTarihiGoster: String, yas: Number,
  cinsiyet:          String, il: String, ilce: String, mahalle: String,
  acik_adres:        String, bina_no: String, daire_no: String, posta_kodu: String,
  tamAdres:          String, anne_ad: String, baba_ad: String,
  telefon:           String, eposta: String, ilkokul_adi: String,
  veli_turu:         String, veli_ad: String, veli_soyad: String, meslek: String,
  kayitTarihi:       String, sinavTarihi: String, sinavSaati: String,
  sinavYeri:         String, sinifNo: Number, siraNo: Number, pdfUrl: String,
}, { timestamps: true, id: false });

const KayitModel = mongoose.model('Kayit', KayitSchema);

// ────────────────────────────────────────────────
// Bellek yedek deposu + DB sarmalayıcı
// ────────────────────────────────────────────────
let bellekKayitlar = [];

const db = {
  async ekle(kayit) {
    if (mongoConnected) return (await KayitModel.create(kayit)).toObject();
    bellekKayitlar.push(kayit);
    return kayit;
  },
  async bul(filtre) {
    if (mongoConnected) return await KayitModel.findOne(filtre).lean();
    if (filtre.id) return bellekKayitlar.find(k => k.id === filtre.id) || null;
    if (filtre.tc) return bellekKayitlar.find(k => k.tc === filtre.tc) || null;
    return null;
  },
  async say() {
    if (mongoConnected) return await KayitModel.countDocuments();
    return bellekKayitlar.length;
  },
  async hepsi() {
    if (mongoConnected) return await KayitModel.find().sort({ createdAt: -1 }).lean();
    return [...bellekKayitlar].reverse();
  },
  async sil(id) {
    if (mongoConnected) { await KayitModel.deleteOne({ id }); return; }
    bellekKayitlar = bellekKayitlar.filter(k => k.id !== id);
  },
  async pdfGuncelle(id, url) {
    if (mongoConnected) { await KayitModel.updateOne({ id }, { pdfUrl: url }); return; }
    const k = bellekKayitlar.find(k => k.id === id);
    if (k) k.pdfUrl = url;
  },
};

// ────────────────────────────────────────────────
// Cloudinary
// ────────────────────────────────────────────────
const cloudinaryAktif =
  !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_CLOUD_NAME !== 'your_cloud_name');

if (cloudinaryAktif) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key:    process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
  console.log('[Cloudinary] Aktif');
} else {
  console.warn('[Cloudinary] Ayarlanmamış — PDF yalnızca indirme olarak sunulacak.');
}

async function pdfCloudinaryYukle(buffer, kayitNo) {
  if (!cloudinaryAktif) return null;
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { resource_type: 'raw', folder: 'sinav-belgeler', public_id: kayitNo, overwrite: true, format: 'pdf' },
      (err, result) => err ? reject(err) : resolve(result)
    );
    stream.end(buffer);
  });
}

// ────────────────────────────────────────────────
// Yardımcılar
// ────────────────────────────────────────────────
function temizle(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'`]/g, '').trim().substring(0, maxLen);
}

function tcGecerliMi(tc) {
  if (!/^\d{11}$/.test(tc) || tc[0] === '0') return false;
  const d = tc.split('').map(Number);
  const tek  = d[0]+d[2]+d[4]+d[6]+d[8];
  const cift = d[1]+d[3]+d[5]+d[7];
  if ((tek*7 - cift) % 10 !== d[9]) return false;
  return d.slice(0,10).reduce((a,b)=>a+b,0) % 10 === d[10];
}

function adresGecerliMi(il, ilce) {
  const urfaData = adresData['Sanliurfa'] || adresData['Şanlıurfa'];
  if (!urfaData || il !== 'Sanliurfa' || !urfaData[ilce]) return false;
  return true;
}

function adminDogrula(ad, tc, adres) {
  const envAd    = (process.env.ADMIN_AD    || '').toLowerCase().trim();
  const envTc    = (process.env.ADMIN_TC    || '').trim();
  const envAdres = (process.env.ADMIN_ADRES || '').toLowerCase().trim();
  if (!envAd || !envTc || !envAdres) return false;
  return (
    ad.toLowerCase().trim()    === envAd &&
    tc.trim()                  === envTc &&
    adres.toLowerCase().trim() === envAdres
  );
}

function kalanGunHesapla() {
  const sinav = new Date('2026-05-17T10:00:00+03:00');
  const fark  = sinav - new Date();
  return fark <= 0 ? 0 : Math.ceil(fark / (1000*60*60*24));
}

function adminGerekli(req, res, next) {
  if (req.session && req.session.adminGiris) return next();
  return res.redirect('/admin');
}

// ────────────────────────────────────────────────
// Helmet
// ────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      imgSrc:     ["'self'", "data:", "https://urfanecmettinerbakaniho.meb.k12.tr", "https://res.cloudinary.com"],
      connectSrc: ["'none'"],
      frameSrc:   ["'none'"],
      objectSrc:  ["'none'"],
    },
  },
  frameguard: { action: 'deny' },
  noSniff:    true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// ────────────────────────────────────────────────
// Rate Limiting
// ────────────────────────────────────────────────
const genelLimit = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15*60*1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX)       || 100,
  standardHeaders: true, legacyHeaders: false,
  message: 'Çok fazla istek. Lütfen daha sonra tekrar deneyin.',
});
const kayitLimit = rateLimit({
  windowMs: 60*60*1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: 'Çok fazla kayıt denemesi. 1 saat sonra tekrar deneyiniz.',
});
const adminLimit = rateLimit({
  windowMs: 15*60*1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: 'Çok fazla hatalı giriş. 15 dakika bekleyiniz.',
});

app.use(genelLimit);

// ────────────────────────────────────────────────
// Middleware
// ────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true, maxAge: '1d',
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));

// ────────────────────────────────────────────────
// Session — bellek tabanlı (MongoStore .env ile gelmez)
// ────────────────────────────────────────────────
app.use(session({
  secret:            process.env.SESSION_SECRET || 'gizli-anahtar-degistir',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure:   false,           // HTTP'de de çalışsın
    httpOnly: true,
    maxAge:   4 * 60 * 60 * 1000,
  },
}));

// ────────────────────────────────────────────────
// GET /  — Anasayfa (kayıt formuna yönlendir)
// ────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.render('kayit', { hata: null, form: {}, adresData, csrfToken: '' });
});

// ────────────────────────────────────────────────
// GET /kayit — Kayıt Formu (menü linki için)
// ────────────────────────────────────────────────
app.get('/kayit', (req, res) => {
  res.render('kayit', { hata: null, form: {}, adresData, csrfToken: '' });
});

// ────────────────────────────────────────────────
// POST /kayit
// ────────────────────────────────────────────────
app.post('/kayit', kayitLimit, async (req, res) => {
  if (req.body.website) return res.redirect('/');

  const ad           = temizle(req.body.ad,           50);
  const soyad        = temizle(req.body.soyad,        50);
  const tc           = (req.body.tc||'').replace(/\D/g,'').substring(0,11);
  const dogum_tarihi = temizle(req.body.dogum_tarihi, 10);
  const cinsiyet     = req.body.cinsiyet === 'kiz' ? 'kiz' : 'erkek';
  const il           = temizle(req.body.il,           50);
  const ilce         = temizle(req.body.ilce,         100);
  const mahalle      = '';
  const acik_adres   = temizle(req.body.acik_adres,   200);
  const bina_no      = temizle(req.body.bina_no,      10);
  const daire_no     = temizle(req.body.daire_no,     10);
  const posta_kodu   = (req.body.posta_kodu||'').replace(/\D/g,'').substring(0,5);
  const anne_ad      = temizle(req.body.anne_ad,      50);
  const baba_ad      = temizle(req.body.baba_ad,      50);
  const telefon      = temizle(req.body.telefon,      20);
  const eposta       = temizle(req.body.eposta,       150);
  const ilkokul_adi  = temizle(req.body.ilkokul_adi,  150);
  const veli_turu    = ['anne','baba'].includes(req.body.veli_turu) ? req.body.veli_turu : 'baba';
  const veli_ad      = temizle(req.body.veli_ad,      50);
  const veli_soyad   = temizle(req.body.veli_soyad,   50);
  const meslek       = temizle(req.body.meslek,       100);

  const formBack = { ad, soyad, tc, dogum_tarihi, cinsiyet, il, ilce,
    acik_adres, bina_no, daire_no, posta_kodu, anne_ad, baba_ad,
    telefon, eposta, ilkokul_adi, veli_turu, veli_ad, veli_soyad, meslek };

  const hataGonder = (mesaj) =>
    res.render('kayit', { hata: mesaj, form: formBack, adresData, csrfToken: '' });

  if (!ad||!soyad||!tc||!dogum_tarihi||!ilce||!acik_adres||!veli_ad||!veli_soyad||!telefon||!ilkokul_adi)
    return hataGonder('Lütfen tüm zorunlu alanları eksiksiz doldurunuz.');

  if (cinsiyet === 'kiz')
    return hataGonder('Kız öğrenciler için kayıt bulunmamaktadır. Sadece erkek öğrenciler başvurabilir.');

  if (!tcGecerliMi(tc))
    return hataGonder('Geçerli bir T.C. Kimlik Numarası giriniz.');

  try {
    const mevcut = await db.bul({ tc });
    if (mevcut)
      return hataGonder(`Bu T.C. ile daha önce kayıt yapılmıştır. Kayıt No: ${mevcut.kayitNo}`);
  } catch(e) {
    return hataGonder('Sunucu hatası. Lütfen tekrar deneyin.');
  }

  const dogum = new Date(dogum_tarihi);
  if (isNaN(dogum.getTime())) return hataGonder('Geçerli bir doğum tarihi giriniz.');
  const bugun = new Date();
  let yas = bugun.getFullYear() - dogum.getFullYear();
  const ayFark = bugun.getMonth() - dogum.getMonth();
  if (ayFark < 0 || (ayFark===0 && bugun.getDate() < dogum.getDate())) yas--;
  if (yas < 7) return hataGonder('Geçerli bir doğum tarihi giriniz (7 yaş ve üzeri olmalıdır).');

  if (!adresGecerliMi(il, ilce))
    return hataGonder('Geçersiz adres bilgisi. Lütfen listeden seçiniz.');

  try {
    const toplam  = await db.say();
    const kayitNo = 'ERB2026-' + String(toplam+1001).padStart(4,'0');
    const kayitId = uuidv4();
    const kayitTarihi = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    const tamAdres = `${acik_adres}${bina_no?' No:'+bina_no:''}${daire_no?' D:'+daire_no:''}, ${ilce} / ${il}${posta_kodu?' – '+posta_kodu:''}`;

    const kayit = await db.ekle({
      id: kayitId, kayitNo,
      ad: ad.toUpperCase(), soyad: soyad.toUpperCase(), tc,
      dogum_tarihi, dogumTarihiGoster: dogum.toLocaleDateString('tr-TR'), yas,
      cinsiyet: 'Erkek', il, ilce, mahalle, acik_adres,
      bina_no:    bina_no    ||'-', daire_no:  daire_no  ||'-',
      posta_kodu: posta_kodu ||'-', tamAdres,
      anne_ad:    anne_ad    ? anne_ad.toUpperCase()    : '-',
      baba_ad:    baba_ad    ? baba_ad.toUpperCase()    : '-',
      telefon:    telefon    ||'-', eposta: eposta||'-',
      ilkokul_adi: ilkokul_adi||'-',
      veli_turu,
      veli_ad:    veli_ad.toUpperCase(),
      veli_soyad: veli_soyad.toUpperCase(),
      meslek:     meslek||'-',
      kayitTarihi,
      sinavTarihi: SINAV_TARIHI, sinavSaati: SINAV_SAATI, sinavYeri: SINAV_YERI,
      sinifNo: Math.floor(toplam / 20) + 1,
      siraNo:  (toplam % 20) + 1,
    });

    res.render('belge', { kayit });
  } catch(e) {
    console.error('[Kayıt]', e.message);
    res.render('kayit', { hata: 'Kayıt sırasında hata oluştu. Lütfen tekrar deneyin.', form: formBack, adresData, csrfToken: '' });
  }
});

// ────────────────────────────────────────────────
// GET /belge/:id
// ────────────────────────────────────────────────
app.get('/belge/:id', async (req, res) => {
  if (!uuidValidate(req.params.id))
    return res.status(404).render('hata', { mesaj: 'Kayıt bulunamadı.' });
  try {
    const kayit = await db.bul({ id: req.params.id });
    if (!kayit) return res.status(404).render('hata', { mesaj: 'Kayıt bulunamadı.' });
    res.render('belge', { kayit });
  } catch(e) {
    res.status(500).render('hata', { mesaj: 'Sunucu hatası.' });
  }
});

// ────────────────────────────────────────────────
// GET /pdf/:id
// ────────────────────────────────────────────────
app.get('/pdf/:id', async (req, res) => {
  if (!uuidValidate(req.params.id)) return res.status(404).send('Kayit bulunamadi.');
  try {
    const kayit = await db.bul({ id: req.params.id });
    if (!kayit) return res.status(404).send('Kayit bulunamadi.');
    if (kayit.pdfUrl) return res.redirect(302, kayit.pdfUrl);

    const buf = await pdfOlustur(kayit);
    const guvenliAd = kayit.kayitNo.replace(/[^A-Z0-9\-]/gi, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="sinav-giris-belgesi-${guvenliAd}.pdf"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(buf);

    pdfCloudinaryYukle(buf, kayit.kayitNo)
      .then(async r => { if (r) { await db.pdfGuncelle(kayit.id, r.secure_url); console.log('[Cloudinary] Yuklendi:', r.secure_url); } })
      .catch(e => console.error('[Cloudinary]', e.message));

  } catch (e) {
    console.error('[PDF]', e.message);
    res.status(500).send('PDF olusturulamadi.');
  }
});

// ────────────────────────────────────────────────
// PDF oluşturma fonksiyonu
// ────────────────────────────────────────────────
function pdfOlustur(kayit) {
  return new Promise((resolve, reject) => {
    try {
      const FONT_R = path.join(__dirname, 'fonts', 'DejaVuSans.ttf');
      const FONT_B = path.join(__dirname, 'fonts', 'DejaVuSans-Bold.ttf');
      const LOGO   = path.join(__dirname, 'public', 'images', 'logo.png');

      const doc = new PDFDocument({ size: 'A4', margin: 0, compress: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const W = 595.28, H = 841.89;
      const ML = 40, MR = 40; // sol/sag margin
      const CW = W - ML - MR; // content width = 515

      // ── Renk paleti ──
      const NAVY   = '#1B2A4A';
      const RED    = '#C0392B';
      const GOLD   = '#D4A017';
      const LGRAY  = '#F4F6F9';
      const MGRAY  = '#E2E8F0';
      const DGRAY  = '#64748B';
      const WHITE  = '#FFFFFF';
      const BLACK  = '#1A1A1A';

      // ── Yardımcılar ──
      const R  = (f) => doc.font(FONT_R).fontSize(f);
      const B  = (f) => doc.font(FONT_B).fontSize(f);

      // Türkçe karakter düzeltme (Helvetica fallback için gerekli değil, DejaVu destekliyor)
      const T = (s) => String(s || '');

      // ── HEADER ──
      // Üst lacivert bant
      doc.rect(0, 0, W, 110).fill(NAVY);

      // Sol logo
      try { doc.image(LOGO, ML, 10, { width: 88, height: 88 }); } catch(e) {}

      // Kurum bilgileri - ortada
      const hx = ML + 100;
      const hw = W - hx - ML;
      B(7.5).fillColor('#A8BCD4').text('T.C. MİLLİ EĞİTİM BAKANLIĞI', hx, 16, { width: hw });
      B(7.5).fillColor('#A8BCD4').text('ŞANLIURFA İL MİLLİ EĞİTİM MÜDÜRLÜĞÜ', hx, 27, { width: hw });
      B(12).fillColor(WHITE).text('Prof. Dr. Necmettin Erbakan', hx, 40, { width: hw });
      B(12).fillColor(WHITE).text('İmam Hatip Ortaokulu', hx, 54, { width: hw });
      R(7.5).fillColor('#A8BCD4').text('Selahaddin Eyyubi Mah. 211. Sk. No:1  Haliliye / Şanliurfa', hx, 70, { width: hw });
      R(7.5).fillColor('#A8BCD4').text('Tel: 0 414 312 70 37  |  urfanecmettinerbakaniho.meb.k12.tr', hx, 81, { width: hw });

      // ── BELGE BAŞLIĞI ──
      doc.rect(0, 110, W, 36).fill(RED);
      B(15).fillColor(WHITE).text('SINAV GİRİŞ BELGESİ', 0, 120, { align: 'center', width: W });

      // ── KAYIT NO BANDI ──
      doc.rect(0, 146, W, 24).fill(LGRAY);
      doc.rect(0, 170, W, 0.5).fill(MGRAY);
      B(8.5).fillColor(NAVY).text('Kayit No: ' + T(kayit.kayitNo), ML, 154, { width: 200 });
      R(7.5).fillColor(DGRAY).text('Düzenleme Tarihi: ' + T(kayit.kayitTarihi), 0, 155, { align: 'right', width: W - MR });

      // ── SINAV BİLGİLERİ KUTUSU (öne al, göze çarpsın) ──
      let y = 182;

      // Kırmızı başlık bandı
      doc.rect(ML, y, CW, 26).fill(RED).stroke(RED);
      B(9).fillColor(WHITE).text('SINAV BİLGİLERİ', ML + 10, y + 8, { width: CW - 20 });
      y += 26;

      // 3 sütunlu grid: Tarih | Saat | Yer
      const gw3 = CW / 3;
      const gridItems = [
        ['SINAV TARİHİ', T(SINAV_TARIHI)],
        ['SINAV SAATİ', T(SINAV_SAATI)],
        ['SALON NO', 'SALON ' + T(kayit.sinifNo)],
        ['SIRA NO', String(kayit.siraNo || 1).padStart(3, '0')],
        ['KAYIT NO', T(kayit.kayitNo)],
        ['BELGE NO', T(kayit.id || '').split('-')[0].toUpperCase()],
      ];

      gridItems.forEach((item, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const cx = ML + col * gw3;
        const cy = y + row * 44;
        const bg = (row === 0 && col % 2 === 0) || (row === 1 && col % 2 === 1) ? WHITE : LGRAY;
        doc.rect(cx, cy, gw3, 44).fill(bg).strokeColor(MGRAY).lineWidth(0.5).stroke();
        R(7).fillColor(DGRAY).text(item[0], cx + 8, cy + 8, { width: gw3 - 16 });
        B(13).fillColor(RED).text(item[1], cx + 8, cy + 20, { width: gw3 - 16 });
      });
      y += 88 + 10;

      // Sınav yeri satırı
      doc.rect(ML, y, CW, 30).fill('#FFF8E1').strokeColor('#E6C44A').lineWidth(0.8).stroke();
      B(8).fillColor('#7B4F00').text('SINAV YERİ:', ML + 10, y + 5, { width: 75 });
      R(8).fillColor('#4A3000').text(T(SINAV_YERI), ML + 85, y + 5, { width: CW - 95 });
      B(7.5).fillColor('#7B4F00').text('ADRES:', ML + 10, y + 17, { width: 75 });
      R(7.5).fillColor('#4A3000').text('Selahaddin Eyyubi Mah. 211. Sk. No:1  Haliliye / Şanliurfa', ML + 85, y + 17, { width: CW - 95 });
      y += 44;

      // ── ÖĞRENCİ BİLGİLERİ ──
      const secBaslik = (title) => {
        doc.rect(ML, y, CW, 24).fill(NAVY).stroke(NAVY);
        B(8.5).fillColor(WHITE).text(title, ML + 10, y + 7, { width: CW - 20 });
        y += 24;
      };

      const satir = (label, value, alt) => {
        const RH = 20;
        doc.rect(ML, y, CW, RH).fill(alt ? LGRAY : WHITE).strokeColor(MGRAY).lineWidth(0.3).stroke();
        doc.moveTo(ML, y + RH).lineTo(ML + CW, y + RH).strokeColor(MGRAY).lineWidth(0.3).stroke();
        B(7.5).fillColor(DGRAY).text(label, ML + 10, y + 5, { width: 140 });
        R(8.5).fillColor(BLACK).text(T(value), ML + 155, y + 4, { width: CW - 165 });
        y += RH;
      };

      secBaslik('ÖĞRENCİ BİLGİLERİ');
      satir('Ad Soyad', T(kayit.ad) + ' ' + T(kayit.soyad), false);
      satir('T.C. Kimlik No', T(kayit.tc), true);
      satir('Dogum Tarihi', T(kayit.dogumTarihiGoster) + '  (' + T(kayit.yas) + ' yas)', false);
      satir('Cinsiyet', T(kayit.cinsiyet), true);
      satir('Mezun Oldugu Ilkokul', T(kayit.ilkokul_adi), false);
      y += 6;

      secBaslik('VELİ / İLETİŞİM BİLGİLERİ');
      satir('Veli Adi Soyadi', T(kayit.veli_ad) + ' ' + T(kayit.veli_soyad), false);
      satir('Yakinlik', kayit.veli_turu === 'anne' ? 'Anne' : 'Baba', true);
      satir('Telefon', T(kayit.telefon), false);
      if (kayit.eposta && kayit.eposta !== '-') satir('E-Posta', T(kayit.eposta), true);
      y += 6;

      secBaslik('ADRES BİLGİLERİ');
      satir('Il / Ilce', T(kayit.il) + ' / ' + T(kayit.ilce), false);
      const adresTam = T(kayit.acik_adres) +
        (kayit.bina_no && kayit.bina_no !== '-' ? ' No:' + kayit.bina_no : '') +
        (kayit.daire_no && kayit.daire_no !== '-' ? ' D:' + kayit.daire_no : '');
      satir('Acik Adres', adresTam, true);
      if (kayit.posta_kodu && kayit.posta_kodu !== '-') satir('Posta Kodu', T(kayit.posta_kodu), false);
      y += 8;

      // ── UYARILAR ──
      const uyarilar = [
        'Bu belgeyi sinav günü yanınızda bulundurmanız ZORUNLUDUR.',
        'Sinava kimlik belgesi (Nüfus Cüzdanı / T.C. Kimlik Kartı) ile girilmelidir.',
        'Sinav saatinden en az 30 dakika önce okulda hazır bulununuz.',
        'Sinav giris ücreti 100 TL olup, sinav günü ödenmesi gerekmektedir.',
        'Cep telefonu ve elektronik cihazlar sinav salonuna alınmayacaktır.',
        'Kurşun kalem ve silgi yanınızda bulunmalıdır.',
      ];
      const uyariH = 16 + uyarilar.length * 13 + 8;
      doc.rect(ML, y, CW, uyariH).fill('#FFF3CD').strokeColor('#F0C040').lineWidth(0.8).stroke();
      B(8.5).fillColor('#7B4F00').text('ÖNEMLİ UYARILAR', ML + 10, y + 7, { width: CW - 20 });
      uyarilar.forEach((u, i) => {
        R(7.8).fillColor('#5D3A00').text('• ' + u, ML + 12, y + 20 + i * 13, { width: CW - 24 });
      });
      y += uyariH + 10;

      // ── BARKOD GÖRÜNÜMLÜ BELGE ID ──
      B(7).fillColor(DGRAY).text('Belge Dogrulama Kodu: ' + T(kayit.id || '').toUpperCase(), ML, y, { width: CW });

      // Alt çizgi kaldırıldı

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// ────────────────────────────────────────────────
// GET /admin — Giriş sayfası
// ────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  if (req.session && req.session.adminGiris) return res.redirect('/admin/panel');
  res.render('admin-giris', { hata: null });
});

// POST /admin — Doğrula ve session kur
app.post('/admin', adminLimit, (req, res) => {
  const ad    = temizle(req.body.ad,    50);
  const tc    = temizle(req.body.tc,    20);
  const adres = temizle(req.body.adres, 100);

  if (!ad || !tc || !adres)
    return res.render('admin-giris', { hata: 'Tüm alanları doldurunuz.' });

  if (adminDogrula(ad, tc, adres)) {
    req.session.adminGiris = true;
    req.session.adminAd    = ad.charAt(0).toUpperCase() + ad.slice(1);
    return req.session.save(() => res.redirect('/admin/panel'));
  }

  res.render('admin-giris', { hata: 'Kimlik bilgileri hatalı. Erişim reddedildi.' });
});

// GET /admin/panel
app.get('/admin/panel', adminGerekli, async (req, res) => {
  try {
    const kayitlar = await db.hepsi();
    const kalanGun = kalanGunHesapla();
    const adminAd  = req.session.adminAd || 'Admin';
    res.render('admin-panel', { kayitlar, kalanGun, adminAd });
  } catch(e) {
    console.error('[Admin Panel]', e.message);
    res.status(500).render('hata', { mesaj: 'Veriler yüklenemedi.' });
  }
});

// POST /admin/sil/:id
app.post('/admin/sil/:id', adminGerekli, async (req, res) => {
  if (uuidValidate(req.params.id)) {
    try { await db.sil(req.params.id); } catch(e) { console.error('[Sil]', e.message); }
  }
  res.redirect('/admin/panel');
});

// GET /admin/cikis
app.get('/admin/cikis', (req, res) => {
  req.session.destroy(() => res.redirect('/admin'));
});

// ────────────────────────────────────────────────
// 404 & Hata
// ────────────────────────────────────────────────
app.use((req, res) => res.status(404).render('hata', { mesaj: 'Sayfa bulunamadı.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[HATA]', err.message);
  res.status(500).render('hata', { mesaj: 'Sunucu hatası oluştu.' });
});

// ────────────────────────────────────────────────
// Başlat
// ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅  Sunucu:  http://localhost:${PORT}`);
  console.log(`   Admin:    http://localhost:${PORT}/admin`);
  console.log(`   Panel:    http://localhost:${PORT}/admin/panel  (giriş sonrası)\n`);
  if (!process.env.ADMIN_AD) console.warn('⚠️  ADMIN_AD .env\'de ayarlanmamış!');
});
