# 🔥 Burner Key — Claude BYOK Reverse Proxy & Kontrol Paneli

> **Tek cümleyle ne yapar?**  
> 3. parti BYOK (Bring Your Own Key) uygulamalarına gerçek Anthropic API anahtarınızı (`sk-ant-...`) vermek yerine; **bütçe limitli, süreli (TTL), izinli model kısıtlı ve tek tıkla yakılabilen (Kill Switch)** geçici `brk_live_...` anahtarları üretir ve tüm AI trafiğini güvenli bir reverse proxy üzerinden geçirir.

---

## 🎯 Problem ve Çözüm

Birçok AI aracı (Cursor, ajan framework'leri, 3. parti web uygulamaları) sizden kendi API anahtarınızı ister. Gerçek anahtarınızı verdiğinizde:
- Uygulamadaki bir **sonsuz döngü bug'ı** faturanızı dakikalar içinde tüketebilir.
- Uygulama sizin izniniz olmadan **pahalı modellere** (ör. Opus) istek atabilir.
- Anahtarı sadece o uygulama için durdurmak istediğinizde tüm projelerdeki anahtarı iptal etmek zorunda kalırsınız.

**Burner Key**, uygulamanın karşısına gerçek Claude API'si gibi çıkar (`/v1/messages`). Uygulama sadece geçici `brk_live_...` anahtarını görür; gerçek anahtarınız ise yalnızca sizin sunucunuzdaki `.env` dosyasında kalır.

---

## 🏗️ Sistem Mimarisi (Nasıl Çalışır?)

```text
┌─────────────────────────────┐
│  3. Parti BYOK Uygulaması   │  (veya sağdaki yerleşik Simülatör)
│  x-api-key: brk_live_...    │
└──────────────┬──────────────┘
               │  POST /v1/messages
               ▼
┌──────────────────────────────────────────────────────────┐
│              Burner Key Proxy (:8000)                    │
│                                                          │
│  1. stream: true mu?           ──▶ Evet: 400 Reddet      │
│  2. Anahtar geçerli/aktif mi?  ──▶ Hayır: 401 (REVOKED)  │
│  3. Süre (TTL) dolmuş mu?      ──▶ Evet: 401 (EXPIRED)   │
│  4. Model izinli listede mi?   ──▶ Hayır: 403 (DENIED)   │
│  5. Bütçe dolmuş mu?           ──▶ Evet: 429 (BUDGET)    │
│                                                          │
│  ✅ Tüm kontroller geçerse gerçek anahtarla iletir        │
│  💰 Dönen usage (input/output token) ile maliyeti düşer  │
└──────────────┬───────────────────────────────────────────┘
               │
               ├──▶ Geliştirme Modu: Fake Claude (:8001)  [Ücretsiz Test]
               └──▶ Canlı Mod:       api.anthropic.com    [Gerçek Claude]
```

---

## 📂 Klasör Yapısı ve 4 Kişilik Ekip Dağılımı

Çakışma (merge conflict) yaşamamak için proje **`backend/`** ve **`frontend/`** olarak ikiye ayrılmıştır. **Altın kural: Herkes yalnızca kendi sorumlu olduğu dosyalarda değişiklik yapar.**

```text
Burner-Key/
├── backend/                  # Backend Ekibi: Muzaffer & Selçuk
│   ├── main.py               # [Muzaffer] FastAPI giriş noktası, CORS, frontend yayını, /health
│   ├── proxy.py              # [Muzaffer] POST /v1/messages proxy motoru
│   ├── fake_claude.py        # [Muzaffer] Ücretsiz test için sahte Claude sunucusu (:8001)
│   ├── keys.py               # [Selçuk]   SQLite DB, check_key/add_spend, /admin/* endpoint'leri
│   ├── pricing.py            # [Selçuk]   Model başına token fiyat tablosu ve maliyet hesabı
│   ├── requirements.txt      # [Ortak]    Python paket bağımlılıkları
│   └── .env.example          # [Ortak]    Ortam değişkeni şablonu
├── frontend/                 # Frontend Ekibi: Kerim & Utku
│   ├── index.html            # [Utku]     Ana HTML kabuğu ve Üst Menü (Ekran Modu Seçici)
│   ├── simulator.js          # [Utku]     3. Parti BYOK Simülatörü + ihlal butonları
│   ├── dashboard.js          # [Kerim]    Anahtar formu, harcama çubuğu, Kill Switch, log tablosu
│   ├── styles.css            # [Kerim]    Koyu geliştirici teması ve özel stiller
│   └── api.js                # [Ortak]    Backend API istemcisi
├── .gitignore                # .env, *.db, .venv ve önbellekleri Git dışında tutar
├── LICENSE
└── README.md
```

### Kim Hangi Dosyadan Sorumlu?

| Ekip Üyesi | Taraf | Dosyalar | Odaklanacağı İşler |
| :--- | :--- | :--- | :--- |
| **Muzaffer** | Backend | `backend/main.py`<br>`backend/proxy.py`<br>`backend/fake_claude.py` | `/v1/messages` proxy akışı, upstream timeout/hata yönetimi, gerçek Anthropic API testi |
| **Selçuk** | Backend | `backend/keys.py`<br>`backend/pricing.py` | SQLite sorguları, bütçe/TTL/model kuralları, `/admin/*` API'leri, güncel model fiyatları |
| **Kerim** | Frontend | `frontend/dashboard.js`<br>`frontend/styles.css` | Kontrol paneli arayüzü, harcama yüzdesi renkleri (`%80+` uyarısı), Kill Switch ve log tablosu |
| **Utku** | Frontend | `frontend/simulator.js`<br>`frontend/index.html` | Yan ekrandaki 3. parti uygulama simülatörü, tek tıkla saldırı/hata senaryoları, görünüm geçişleri |

---

## 🚀 Sıfırdan Kurulum ve Çalıştırma (Adım Adım)

Projeyi bilgisayarınıza klonladıktan sonra çalıştırmak için yalnızca **Python 3.10+** yeterlidir (Node.js/npm veya veritabanı kurulumu gerekmez).

### Adım 1: Sanal Ortam ve Paketleri Kurun (Tek Seferlik)

**Windows (PowerShell):**
```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
```

**macOS / Linux:**
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

### Adım 2: İki Sunucuyu Başlatın (2 Ayrı Terminal)

**Terminal 1 — Sahte Claude Sunucusu (`backend/` klasöründen):**
```powershell
# Windows:
.\.venv\Scripts\python.exe fake_claude.py

# macOS / Linux:
python fake_claude.py
```
> Port `8001`'de çalışır. Hiç gerçek API kredisi harcamadan gerçekçi Claude yanıtları ve rastgele token `usage` değerleri üretir.

**Terminal 2 — Burner Key Proxy & Kontrol Paneli (`backend/` klasöründen):**
```powershell
# Windows:
.\.venv\Scripts\python.exe main.py

# macOS / Linux:
python main.py
```
> Port `8000`'de çalışır. Hem API endpoint'lerini hem de `frontend/` arayüzünü sunar.

### Adım 3: Tarayıcıda Açın

- **Uygulama & Demo Ekranı:** `http://127.0.0.1:8000`
- **Otomatik API Dokümantasyonu (Swagger):** `http://127.0.0.1:8000/docs`

> **💡 Frontend Ekibi (Kerim & Utku) İçin İpucu:**  
> `frontend/` içindeki `.html`, `.js` veya `.css` dosyalarını düzenlediğinizde sunucuyu yeniden başlatmanız gerekmez; tarayıcıda `F5` (yenile) yapmanız yeterlidir. İsterseniz `frontend/` içinde `python -m http.server 5173` (veya VS Code Live Server) da açabilirsiniz; `frontend/api.js` otomatik olarak `http://127.0.0.1:8000` backend'ine bağlanır.

---

## 🔑 Gerçek Claude API'ye Geçiş Nasıl Yapılır?

Testleri bitirip gerçek Anthropic Claude API'si ile deneme yapmak istediğinizde yalnızca `backend/.env` dosyasını güncelleyin *(bu dosya Git'e gitmez)*:

```env
ANTHROPIC_API_KEY=sk-ant-api03-GERCEK-ANAHTARINIZ
UPSTREAM_BASE_URL=https://api.anthropic.com
PORT=8000
DATABASE_PATH=burner_keys.db
```

Ardından `main.py` terminalini yeniden başlatın (`fake_claude.py` gerekmez).

---

## 🤝 Ekip İçi Teknik Sözleşmeler

### 1. Backend İçi Sözleşme (`backend/keys.py` ↔ `backend/proxy.py`)

Muzaffer ve Selçuk birbirinin kodunu bozmadan çalışabilmesi için sadece şu iki Python fonksiyonu üzerinden haberleşir:

- **`check_key(key: str, model: str) -> tuple[int | None, int | None, str | None]`**
  - Anahtar geçerliyse `(key_id, None, None)` döner.
  - Kural ihlali varsa `(None, hata_kodu, mesaj)` döner ve olayı otomatik olarak `request_logs` tablosuna yazar.
- **`add_spend(key_id: int, model: str, input_tokens: int, output_tokens: int) -> float`**
  - `pricing.calculate_cost()` ile maliyeti hesaplar, anahtarın `spent_usd` ve `request_count` değerini artırır, `200` log kaydı ekler.

### 2. Frontend İçi Sözleşme (`frontend/dashboard.js` ↔ `frontend/simulator.js`)

Kerim ve Utku'nun dosyaları birbirini doğrudan `import` etmez; tarayıcı içi özel olaylarla (`CustomEvent`) haberleşir:

- **`burner:select-key`** (`detail: { apiKey }`): Panelde yeni anahtar üretildiğinde veya **"Simülatöre Gönder"** tıklandığında `simulator.js` içindeki anahtar kutusunu otomatik doldurur.
- **`burner:activity`**: Simülatör her istek attığında `dashboard.js` beklemeden (2 sn timer'ı beklemeden) harcama çubuğunu ve log tablosunu anında yeniler.

### 3. HTTP API Özeti

| Method & Yol | Açıklama | Başarılı / Hata Kodları |
| :--- | :--- | :--- |
| `GET /health` | Servis sağlık durumu ve aktif upstream adresi | `200` |
| `GET /admin/models` | Desteklenen Claude modelleri listesi | `200` |
| `POST /admin/keys` | Yeni geçici Burner Key üretir (ham anahtar 1 kez döner) | `201`, `422` |
| `GET /admin/keys` | Tüm anahtarları canlı durum (`active/revoked/expired/budget_exceeded`) ile listeler | `200` |
| `POST /admin/keys/{id}/revoke` | **Kill Switch:** Anahtarı anında iptal eder | `200`, `404` |
| `GET /admin/logs` | Son proxy istek loglarını döner (`?limit=50`) | `200` |
| `POST /v1/messages` | Anthropic uyumlu proxy (`x-api-key: brk_live_...`) | `200`, `400` (`stream`), `401` (iptal/süre), `403` (yasaklı model), `429` (bütçe) |

---

## 🌿 Git Çalışma Kuralları

Her küçük satırda push/pull yapmaya gerek yoktur; anlamlı bir parça bittiğinde (ör. 20–30 dakikada bir) aşağıdaki sırayı izleyin:

```powershell
git add <sadece-kendi-dosyaniz>
git commit -m "feat(ui): add 80 percent budget warning indicator"
git pull --rebase origin main
git push origin main
```

- **Commit Mesajları (İngilizce Conventional Commits):**
  - `feat(proxy): add upstream request timeout handling`
  - `fix(keys): prevent budget overflow on concurrent requests`
  - `style(ui): improve key table readability and badges`
  - `docs(readme): update demo instructions`
- **Güvenlik:** Gerçek API anahtarları **yalnızca** `backend/.env` içine yazılır; asla commit edilmez.

---

## 🎬 Jüri / Canlı Demo Akışı (2 Dakikalık Senaryo)

Sunumda **"Bölünmüş Ekran"** modunu açık tutun (Sol: Kontrol Paneli, Sağ: 3. Parti AI Uygulaması):

1. **Anahtar Üret:** Solda bütçesi `$0.005`, izinli modeli yalnızca `claude-3-5-haiku-20241022` olan bir Burner Key oluşturun. Anahtar otomatik sağ tarafa geçer.
2. **Normal Kullanım (`200 OK`):** Sağdan bir soru sorun. Yanıt gelir, soldaki harcama çubuğu ve canlı loglar anında güncellenir.
3. **Model Kısıtlaması (`403`):** Sağdaki **"Yasaklı Model Dene (Opus • 403)"** butonuna basın. Proxy pahalı modele geçişi anında engeller.
4. **Sonsuz Döngü Koruması (`429`):** **"Sonsuz Döngü Bug'ı Tetikle (429)"** butonuna basın. Uygulama art arda istek atmaya başlar; bütçe `$0.005`'e ulaştığı milisaniyede proxy trafiği keser (`429`).
5. **Kill Switch (`401`):** Yeni aktif bir anahtarla normal sohbet atarken soldan kırmızı **"İptal Et"** butonuna basın. Sonraki ilk istek anında `401` ile durdurulur.
