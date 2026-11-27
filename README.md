# Burner Key — Claude BYOK Reverse Proxy

3. parti BYOK (Bring Your Own Key) uygulamalarına gerçek Anthropic API anahtarını vermek yerine **bütçe, süre (TTL), izinli model kısıtlı** ve **tek tıkla iptal edilebilen (Kill Switch)** geçici `brk_live_...` anahtarları üreten `/v1/messages` uyumlu reverse proxy ve kontrol paneli.

---

## Dosya Sahipliği (Çakışmasız 4 Kişilik Akış)

| Dosya | Sahibi | Sorumluluk |
| :--- | :--- | :--- |
| `main.py` | **Kişi 1** | FastAPI giriş noktası, CORS, `static/` sunumu, `/health` |
| `proxy.py` | **Kişi 1** | `POST /v1/messages` reverse proxy, `stream=true` reddi, upstream iletimi |
| `keys.py` | **Kişi 2** | SQLite tabloları, `check_key()` & `add_spend()` sözleşmesi, `/admin/*` uç noktaları |
| `pricing.py` | **Kişi 2** | Anthropic model başına token fiyat tablosu ve maliyet hesabı |
| `static/index.html` | **Kişi 3** | Tek dosyalık karanlık kontrol paneli (form, harcama barı, iptal, 2 sn yenileme) |
| `fake_claude.py` | **Kişi 4** | Sıfır maliyetli sahte Anthropic `/v1/messages` sunucusu (port `8001`) |
| `demo_app.py` | **Kişi 4** | Burner key ile `/v1/messages` kullanan demo CLI sohbet uygulaması |
| `README.md` | **Kişi 4** | Kurulum, sunum ve test senaryoları |

### Kişi 1 ↔ Kişi 2 Sözleşmesi (`keys.py`)

- `check_key(key, model) -> (key_id, err_status, err_msg)`: Geçerliyse `(key_id, None, None)`, değilse `(None, 401/403/429, mesaj)` döner.
- `add_spend(key_id, model, input_tokens, output_tokens) -> cost_usd`: Maliyeti hesaplar, harcamayı ve logu günceller.

---

## Kurulum ve Çalıştırma (Yerel)

### 1. Ortamı Hazırla

```powershell
python -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
copy .env.example .env
```

*(Varsayılan `.env` ayarı `UPSTREAM_BASE_URL=http://127.0.0.1:8001` ile doğrudan `fake_claude.py`'ye bağlanır. Gerçek Claude testi için `.env` içinde `UPSTREAM_BASE_URL=https://api.anthropic.com` ve gerçek `ANTHROPIC_API_KEY` girin.)*

### 2. Sunucuları Başlat (2 Ayrı Terminal)

**Terminal 1 — Sahte Claude Sunucusu (Kişi 4):**
```powershell
.\.venv\Scripts\python fake_claude.py
```

**Terminal 2 — Burner Key Proxy & Panel (Kişi 1):**
```powershell
.\.venv\Scripts\python main.py
```

Tarayıcıdan kontrol panelini açın: `http://127.0.0.1:8000`

### 3. Demo Uygulaması ile Test (Terminal 3)

Panelden ürettiğiniz `brk_live_...` anahtarını kopyalayıp çalıştırın:

```powershell
# Normal sohbet
.\.venv\Scripts\python demo_app.py --key brk_live_... --message "Merhaba Claude!"

# İzinsiz model testi (403)
.\.venv\Scripts\python demo_app.py --key brk_live_... --model claude-3-opus-20240229 --message "Pahalı model dene"

# İnteraktif mod (bütçe dolana veya panelden İptal Et'e basana kadar)
.\.venv\Scripts\python demo_app.py --key brk_live_...
```
