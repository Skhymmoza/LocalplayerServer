# LocalPlayer Server Deployment on Render

## Быстрый деплой:

### 1. Создайте аккаунт на Render.com (если нет)
https://render.com

### 2. Создайте новый Web Service
- Dashboard → New → Web Service
- Connect your Git repository ИЛИ
- Deploy from this directory

### 3. Настройки:
- **Name**: localplayer-server
- **Environment**: Node
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Instance Type**: Free

### 4. После деплоя:
Вы получите URL типа: `https://localplayer-server.onrender.com`

### 5. Обновите Android приложение:
В файле `SignalingClient.java` замените:
```java
private static final String SERVER_URL = "wss://your-app-name.onrender.com";
```
на ваш реальный URL:
```java
private static final String SERVER_URL = "wss://localplayer-server.onrender.com";
```

## База данных уже настроена!
Сервер использует вашу PostgreSQL базу с Render:
- Host: dpg-d66uphi48b3s73d0s8f0-a.frankfurt-postgres.render.com
- Database: localplayersql
- User: localplayer

## Проверка работы:
После деплоя откройте в браузере:
- `https://your-app.onrender.com/health` - проверка статуса
- `https://your-app.onrender.com/stats` - статистика

## Готово! 🎉
Теперь ваше Android приложение будет подключаться к серверу и устройства будут видеть друг друга!
