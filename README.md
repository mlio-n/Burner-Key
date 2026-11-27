# Burner Key — Claude BYOK Reverse Proxy

3. parti BYOK (Bring Your Own Key) uygulamalarına gerçek Anthropic API anahtarını vermek yerine **bütçe, süre (TTL), izinli model kısıtlı** ve **tek tıkla iptal edilebilen (Kill Switch)** geçici `brk_live_...` anahtarları üreten `/v1/messages` uyumlu reverse proxy ve kontrol paneli.

---

## Proje Yapısı ve Ekip Dağılımı

Proje çakışmasız paralel çalışma için **`backend/`** ve **`frontend/`** olarak iki ana klasöre ayrılmıştır:

```text
Burner-Key/
├── backend/                  # Muzaffer & Selçuk
│   ├── main.py               # Muzaffer — FastAPI uygulaması, CORS, frontend static sunumu
│   ├── proxy.py              # Muzaffer — POST /v1/messages reverse proxy motoru
│   ├── fake_claude.py        # Muzaffer — Sıfır maliyetli sahte Claude sunucusu (:8001)
│   ├── keys.py               # Selçuk   — SQLite DB, check_key/add_spend, /admin/* endpoint'leri
│   ├── pricing.py            # Selçuk   — Model bazlı token fiyatlandırması
│   ├── requirements.txt
│   └── .env.example
├── frontend/                 # Kerim & Utku
│   ├── index.html            # Utku     — Ana HTML kabuğu ve görünüm geçişleri
│   ├── simulator.js          # Utku     — 3. Parti BYOK simülatörü + ihlal senaryoları
│   ├── dashboard.js          # Kerim    — Anahtar oluşturma, harcama barı, Kill Switch, loglar
│   ├── styles.css            # Kerim    — Koyu geliştirici teması stilleri
│   └── api.js                # Ortak    — Backend API istemcisi
├── .gitignore
├── LICENSE
└── README.md
```

### Dosya Sahipliği Tablosu

| Ekip Üyesi | Taraf | Sorumlu Olduğu Dosyalar |
| :--- | :--- | :--- |
| **Muzaffer** | Backend | `backend/main.py`, `backend/proxy.py`, `backend/fake_claude.py` |
| **Selçuk** | Backend | `backend/keys.py`, `backend/pricing.py` |
| **Kerim** | Frontend | `frontend/dashboard.js`, `frontend/styles.css` |
| **Utku** | Frontend | `frontend/simulator.js`, `frontend/index.html` |

### İç Sözleşme (`backend/keys.py` ↔ `backend/proxy.py`)

- `check_key(key, model) -> (key_id, err_status, err_msg)`: Geçerliyse `(key_id, None, None)`, değilse `(None, 401/403/429, mesaj)` döner.
- `add_spend(key_id, model, input_tokens, output_tokens) -> cost_usd`: Maliyeti hesaplar, harcamayı ve logu günceller.

---

## Kurulum ve Çalıştırma (Yerel)

### 1. Backend Kurulumu (tek seferlik)

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
```

*(Varsayılan `backend/.env` ayarı `UPSTREAM_BASE_URL=http://127.0.0.1:8001` ile doğrudan `fake_claude.py`'ye bağlanır. Gerçek Claude için `https://api.anthropic.com` ve gerçek `ANTHROPIC_API_KEY` yazın.)*

### 2. Sunucuları Başlat (2 Ayrı Terminal)

**Terminal 1 — Sahte Claude Sunucusu (`backend/` içinden):**
```powershell
.\.venv\Scripts\python.exe fake_claude.py
```

**Terminal 2 — Burner Key Proxy & Frontend (`backend/` içinden):**
```powershell
.\.venv\Scripts\python.exe main.py
```

Tarayıcıdan açın: `http://127.0.0.1:8000`

*(İsteğe bağlı: Kerim ve Utku frontend üzerinde bağımsız sunucuyla çalışmak isterse `frontend/` içinden `python -m http.server 5173` çalıştırabilir; `frontend/api.js` otomatik olarak `http://127.0.0.1:8000` backend'ine bağlanır.)*
