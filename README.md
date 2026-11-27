# 🔥 Burner Key — Evrensel AI BYOK Reverse Proxy & Kontrol Paneli

> **Tek cümleyle ne yapar?**  
> 3. parti BYOK (Bring Your Own Key) uygulamalarına gerçek AI API anahtarınızı (**OpenAI, Claude, Google Gemini, Groq, DeepSeek, OpenRouter veya Ollama**) vermek yerine; **bütçe limitli, süreli (TTL), izinli model kısıtlı ve tek tıkla yakılabilen (Kill Switch)** geçici `brk_live_...` anahtarları üretir ve tüm AI trafiğini güvenli bir reverse proxy üzerinden geçirir.

---

## 🎯 Problem ve Çözüm

Birçok AI aracı (Cursor, ajan framework'leri, 3. parti web uygulamaları) sizden kendi API anahtarınızı ister. Gerçek anahtarınızı verdiğinizde:
- Uygulamadaki bir **sonsuz döngü bug'ı** faturanızı dakikalar içinde tüketebilir.
- Uygulama sizin izniniz olmadan **pahalı modellere** (ör. Opus / GPT-4o) istek atabilir.
- Tek bir uygulama için anahtarı durdurmak istediğinizde tüm projelerdeki anahtarı iptal etmek zorunda kalırsınız.

**Burner Key**, hem **OpenAI (`/v1/chat/completions`)** hem **Anthropic (`/v1/messages`)** uyumlu evrensel bir proxy olarak araya girer:
- Gerçek anahtarlarınız **Fernet ile şifrelenerek Master Key Kasası'nda** saklanır, dışarı asla çıkmaz.
- 3. parti uygulama yalnızca geçici `brk_live_...` anahtarını görür.
- Uygulama OpenAI formatında istek atıp arka planda Claude/Gemini kullanabilir (veya tersi) — proxy protokolü otomatik çevirir.

---

## 🌐 Desteklenen Sağlayıcılar

| Sağlayıcı ID | İsim | Protokol | Anahtar Öneki (Otomatik Algılama) |
| :--- | :--- | :--- | :--- |
| `mock` | Mock / Test Sunucusu (Ücretsiz) | Mock | `sk-mock...` (varsayılan test kasası) |
| `openai` | OpenAI | OpenAI | `sk-...`, `sk-proj-...` |
| `anthropic` | Anthropic (Claude) | Anthropic | `sk-ant-...` |
| `gemini` | Google Gemini | OpenAI Uyumlu | `AIza...` |
| `groq` | Groq | OpenAI Uyumlu | `gsk_...` |
| `deepseek` | DeepSeek | OpenAI Uyumlu | `sk-...` |
| `openrouter` | OpenRouter | OpenAI Uyumlu | `sk-or-v1-...` |
| `custom` | Özel (Ollama / Yerel LLM) | OpenAI Uyumlu | İsteğe bağlı |

---

## 🏗️ Sistem Mimarisi (Nasıl Çalışır?)

```text
┌──────────────────────────────────────────────────────────┐
│  3. Parti BYOK Uygulaması / Simülatör                    │
│  POST /v1/chat/completions  (Authorization: Bearer brk_) │
│  veya POST /v1/messages     (x-api-key: brk_live_...)    │
└────────────────────────────┬─────────────────────────────┘
                             ▼
┌──────────────────────────────────────────────────────────┐
│            Burner Key Evrensel Proxy (:8000)             │
│                                                          │
│  1. stream: true mu?          ──▶ Evet: 400 Reddet       │
│  2. Anahtar aktif/geçerli mi? ──▶ Hayır: 401 (REVOKED)   │
│  3. Süre (TTL) dolmuş mu?     ──▶ Evet: 401 (EXPIRED)    │
│  4. Model izinli listede mi?  ──▶ Hayır: 403 (DENIED)    │
│  5. Bütçe dolmuş mu?          ──▶ Evet: 429 (BUDGET)     │
│                                                          │
│  🔐 Master Key kasadan çözülür + protokol çevrilir       │
│  💰 Dönen token usage ile maliyet hesaplanır ve düşülür  │
└────────────────────────────┬─────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
   Mock AI (:8001)      OpenAI / Gemini     Anthropic Claude
   (Ücretsiz Test)      Groq / DeepSeek     (/v1/messages)
```

---

## 📂 Klasör Yapısı ve 4 Kişilik Ekip Dağılımı

Çakışma (merge conflict) yaşamamak için proje **`backend/`** ve **`frontend/`** olarak ikiye ayrılmıştır. **Altın kural: Herkes yalnızca kendi sorumlu olduğu dosyalarda değişiklik yapar.**

```text
Burner-Key/
├── start.bat                 # Windows tek tıkla kurulum + başlatma dosyası
├── backend/                  # Backend Ekibi: Muzaffer & Selçuk
│   ├── main.py               # [Muzaffer] FastAPI giriş noktası, CORS, frontend yayını, /health
│   ├── proxy.py              # [Muzaffer] Çift protokollü evrensel proxy (/v1/messages & /v1/chat/completions)
│   ├── mock_upstream.py      # [Muzaffer] Ücretsiz çift protokollü Mock AI sunucusu (:8001)
│   ├── keys.py               # [Selçuk]   SQLite DB, Fernet kasa, check_key/get_upstream_target/add_spend, /admin/*
│   ├── pricing.py            # [Selçuk]   Çoklu sağlayıcı kataloğu, anahtar algılama, token fiyatlandırması
│   ├── requirements.txt      # [Ortak]    Python paket bağımlılıkları
│   └── .env.example          # [Ortak]    Ortam değişkeni şablonu
├── frontend/                 # Frontend Ekibi: Kerim & Utku
│   ├── index.html            # [Utku]     Ana HTML kabuğu ve Üst Menü (Ekran Modu Seçici)
│   ├── simulator.js          # [Utku]     3. Parti BYOK Simülatörü + ihlal butonları
│   ├── dashboard.js          # [Kerim]    Anahtar formu, harcama çubuğu, Kill Switch, log tablosu
│   ├── styles.css            # [Kerim]    Koyu geliştirici teması ve özel stiller
│   └── api.js                # [Ortak]    Backend API istemcisi
├── .gitignore                # .env, *.key, *.db, .venv ve önbellekleri Git dışında tutar
├── LICENSE
└── README.md
```

### Kim Hangi Dosyadan Sorumlu?

| Ekip Üyesi | Taraf | Dosyalar | Odaklanacağı İşler |
| :--- | :--- | :--- | :--- |
| **Muzaffer** | Backend | `backend/main.py`<br>`backend/proxy.py`<br>`backend/mock_upstream.py` | Çift protokollü proxy yönlendirmesi, çapraz çeviri, hata/timeout yönetimi |
| **Selçuk** | Backend | `backend/keys.py`<br>`backend/pricing.py` | Fernet Master Key kasası, SQLite kuralları, `/admin/*` API'leri, çoklu model fiyatları |
| **Kerim** | Frontend | `frontend/dashboard.js`<br>`frontend/styles.css` | Kontrol paneli arayüzü, harcama yüzdesi renkleri (`%80+` uyarısı), Kill Switch ve log tablosu |
| **Utku** | Frontend | `frontend/simulator.js`<br>`frontend/index.html` | Yan ekrandaki 3. parti uygulama simülatörü, tek tıkla ihlal senaryoları, görünüm geçişleri |

---

## 🚀 Kurulum ve Çalıştırma

### Seçenek A — Windows Tek Tıkla Başlatma (Önerilen)

Ana klasördeki **`start.bat`** dosyasına çift tıklayın:
1. İlk çalıştırmada `backend/.venv` ve `backend/.env` yoksa otomatik oluşturur ve paketleri kurar.
2. **Mock AI (:8001)** ve **Burner Key Proxy & UI (:8000)** pencerelerini ayrı ayrı açar.
3. Tarayıcınızda otomatik olarak `http://127.0.0.1:8000` adresini açar.

### Seçenek B — Manuel Kurulum ve Başlatma

**1. Kurulum (tek seferlik):**
```powershell
# Windows (PowerShell):
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
```

```bash
# macOS / Linux:
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

**2. Sunucuları Başlatın (2 Ayrı Terminal, `backend/` içinden):**
```powershell
# Terminal 1 — Mock AI Sunucusu (:8001):
.\.venv\Scripts\python.exe mock_upstream.py

# Terminal 2 — Burner Key Proxy & Arayüz (:8000):
.\.venv\Scripts\python.exe main.py
```

**3. Tarayıcıdan Açın:**
- **Uygulama & Demo Ekranı:** `http://127.0.0.1:8000`
- **API Dokümantasyonu (Swagger):** `http://127.0.0.1:8000/docs`

> **💡 Frontend Ekibi (Kerim & Utku) İçin İpucu:**  
> `frontend/` içindeki dosyaları düzenlediğinizde sunucuyu yeniden başlatmanız gerekmez; tarayıcıda `F5` yapmanız yeterlidir. İsterseniz `frontend/` içinde `python -m http.server 5173` da çalıştırabilirsiniz (`frontend/api.js` otomatik olarak `http://127.0.0.1:8000` backend'ine bağlanır).

---

## 🔐 Master Key Kasası Nasıl Kullanılır?

Sistem ilk açıldığında otomatik olarak ücretsiz bir **`Mock / Test Kasası`** oluşturur. Gerçek OpenAI, Claude, Gemini veya Groq anahtarı kullanmak için:

1. `POST /admin/master-keys` uç noktasına gerçek anahtarınızı gönderin (veya Swagger `http://127.0.0.1:8000/docs` üzerinden test edin):
   ```json
   {
     "name": "OpenAI Prod",
     "provider": "auto",
     "api_key": "sk-proj-..."
   }
   ```
   - `provider: "auto"` bırakıldığında sistem anahtar önekinden (`sk-ant-`, `AIza`, `gsk_`, `sk-or-`, `sk-`) sağlayıcıyı ve `base_url` adresini otomatik bulur.
   - Anahtar **Fernet** ile şifrelenerek SQLite'a yazılır (`ENCRYPTION_KEY` boşsa yerelde gitignored `backend/.secret.key` otomatik oluşturulur).
2. Yeni Burner Key üretirken (`POST /admin/keys`) bu Master Key'in `master_key_id` değerini bağlayın. (`master_key_id` verilmezse varsayılan Mock kasasına bağlanır.)

---

## 🤝 Ekip İçi Teknik Sözleşmeler

### 1. Backend İçi Sözleşme (`backend/keys.py` ↔ `backend/proxy.py`)

- **`check_key(key: str, model: str) -> tuple[int | None, int | None, str | None]`**: Anahtar geçerliyse `(key_id, None, None)`, değilse `(None, 401/403/429, mesaj)` döner ve olayı loglar (`allowed_models` içinde `"*"` tüm modellere izin verir).
- **`get_upstream_target(key_id: int) -> dict[str, str]`**: Burner key'e bağlı Master Key'in şifresini çözüp `{provider, protocol, base_url, api_key}` döner.
- **`add_spend(key_id: int, model: str, input_tokens: int, output_tokens: int) -> float`**: Maliyeti hesaplar, harcamayı ve logu günceller.

### 2. Frontend İçi Sözleşme (`frontend/dashboard.js` ↔ `frontend/simulator.js`)

- **`burner:select-key`** (`detail: { apiKey }`): Panelde yeni anahtar üretildiğinde `simulator.js` kutusunu otomatik doldurur.
- **`burner:activity`**: Simülatör her istek attığında `dashboard.js` harcama çubuğunu ve logları anında yeniler.

### 3. HTTP API Özeti

| Method & Yol | Açıklama | Kodlar |
| :--- | :--- | :--- |
| `GET /health` | Servis sağlık durumu ve `universal_proxy` bilgisi | `200` |
| `GET /admin/providers` | Desteklenen sağlayıcılar, varsayılan URL'ler ve model listeleri | `200` |
| `GET /admin/models` | Desteklenen modeller (`?provider=openai` ile filtrelenebilir) | `200` |
| `POST /admin/master-keys` | Gerçek API anahtarını şifreli kasaya ekler (sağlayıcıyı otomatik tanır) | `201` |
| `GET /admin/master-keys` | Kayıtlı Master Key'leri maskelenmiş önizlemeyle listeler | `200` |
| `DELETE /admin/master-keys/{id}` | Bağlı burner key'i olmayan Master Key'i siler | `200`, `400`, `409` |
| `POST /admin/keys` | Yeni Burner Key üretir (`master_key_id` opsiyonel, ham anahtar 1 kez döner) | `201`, `404`, `422` |
| `GET /admin/keys` | Tüm Burner Key'leri canlı durumlarıyla listeler | `200` |
| `POST /admin/keys/{id}/revoke` | **Kill Switch:** Anahtarı anında iptal eder | `200`, `404` |
| `GET /admin/logs` | Son proxy istek loglarını döner (`?limit=50`) | `200` |
| `POST /v1/messages` | Anthropic uyumlu proxy (`x-api-key` veya `Bearer brk_live_...`) | `200`, `400`, `401`, `403`, `429` |
| `POST /v1/chat/completions` | OpenAI uyumlu proxy (`Authorization: Bearer brk_live_...`) | `200`, `400`, `401`, `403`, `429` |

---

## 🌿 Git Çalışma Kuralları

Anlamlı bir parça bittiğinde yalnızca kendi dosyanızı ekleyip İngilizce Conventional Commit ile gönderin:

```powershell
git add <sadece-kendi-dosyaniz>
git commit -m "feat(ui): add master key selector to dashboard"
git pull --rebase origin main
git push origin main
```

- **Güvenlik:** Gerçek API anahtarları **yalnızca** `backend/.env` veya yerel şifreli veritabanında (`*.db`, `*.key`) kalır; asla commit edilmez.

---

## 🎬 Jüri / Canlı Demo Akışı (2 Dakikalık Senaryo)

Sunumda üst bardaki **"Tümü"** görünümünü açık tutun (Sol: Kontrol Paneli, Sağ: 3. Parti AI Uygulaması / Simülatör):

1. **Anahtar Üret:** Solda kotası `$0.005` olan bir Burner Key oluşturun (anahtarlar tüm modellere izinlidir). Anahtar otomatik olarak sağdaki simülatöre geçer.
2. **Normal Kullanım (`200 OK`):** Sağdan bir soru sorun. Yanıt gelir, harcama göstergesi ve canlı loglar anında güncellenir.
3. **Yanmış Anahtar (`401`):** Simülatördeki **"401 Yanmış anahtar"** butonuna basın. Geçici bir demo anahtar üretilir, anında yakılır ve onunla istek atılır; proxy isteği `401` ile reddeder (konsolda ve canlı logda görünür). Mevcut anahtarınız etkilenmez.
4. **Sonsuz Döngü Koruması (`429`):** **"429 Sonsuz döngü"** butonuna basın. Uygulama art arda istek atmaya başlar; bütçe `$0.005`'e ulaştığı anda proxy trafiği keser (`429`).
5. **Kill Switch (`401`):** Yeni aktif bir anahtarla sohbet ederken soldaki **BURN** butonuna basın ve **CONFIRM BURN?** ile onaylayın. Sonraki ilk istek anında `401` ile durdurulur.
