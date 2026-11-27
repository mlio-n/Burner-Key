@echo off
chcp 65001 >nul
setlocal

set "ROOT_DIR=%~dp0"
set "BACKEND_DIR=%ROOT_DIR%backend"

cd /d "%BACKEND_DIR%" || (
    echo [HATA] backend klasoru bulunamadi: "%BACKEND_DIR%"
    pause
    exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
    echo [KURULUM] Sanal ortam olusturuluyor...
    python -m venv .venv || (
        echo [HATA] Python venv olusturulamadi. Python 3.10+ kurulu oldugundan emin olun.
        pause
        exit /b 1
    )
    echo [KURULUM] Bagimliliklar yukleniyor...
    ".venv\Scripts\python.exe" -m pip install -r requirements.txt || (
        echo [HATA] Paketler yuklenemedi.
        pause
        exit /b 1
    )
) else (
    ".venv\Scripts\python.exe" -c "import cryptography" 2>nul || (
        echo [GUNCELLEME] Yeni Python paketleri yukleniyor...
        ".venv\Scripts\python.exe" -m pip install -r requirements.txt || (
            echo [HATA] Paketler guncellenemedi.
            pause
            exit /b 1
        )
    )
)

if not exist ".env" (
    if exist ".env.example" (
        copy /Y ".env.example" ".env" >nul
        echo [KURULUM] .env dosyasi .env.example uzerinden olusturuldu.
    )
)

echo [BASLATILIYOR] Mock AI sunucusu (http://127.0.0.1:8001)...
start "Burner Key - Mock AI (:8001)" /D "%BACKEND_DIR%" cmd /k ".venv\Scripts\python.exe fake_claude.py"

echo [BASLATILIYOR] Burner Key Proxy ^& Arayuz (http://127.0.0.1:8000)...
start "Burner Key - Proxy & UI (:8000)" /D "%BACKEND_DIR%" cmd /k ".venv\Scripts\python.exe main.py"

timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8000"

echo.
echo [HAZIR] Burner Key calisiyor: http://127.0.0.1:8000
echo Kapatmak icin acilan iki terminal penceresini kapatabilirsiniz.
endlocal
