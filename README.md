# Yandex Cloud account monitor

Docker-приложение для просмотра биллинговых грантов и трафика CDN по нескольким аккаунтам. Backend аутентифицируется авторизованными ключами сервисных аккаунтов; файлы ключей никогда не отдаются браузеру. Интерфейс обновляет кэш каждую минуту и предоставляет ручную кнопку обновления.

## Конфигурация аккаунтов

Файл [`config/accounts.json`](config/accounts.json) уже заполнен первым аккаунтом. Для остальных создайте копию структуры из [`config/accounts.example.json`](config/accounts.example.json) и укажите имя панели, billing account ID, дату старта, путь к ключу и все каталоги с CDN.

В каждой папке назначьте сервисному аккаунту `cdn.viewer` и `monitoring.viewer`. На целевой платежный аккаунт назначьте `billing.accounts.viewer`. В конфиге для каждого платежного аккаунта укажите корректную дату старта гранта.

Backend считает расход гранта как применённую сумму `monetary_grant_credit` из Billing Usage API; остаток — `max(0, 4000 − расход)`. Дни до конца — от даты старта плюс 60 дней. Трафик CDN для сравнения с показателем отправки из Cloud CDN считается по `edge.bytes_sent` (передано клиентам). `origin.bytes_fetched` хранится и отображается отдельно, но не прибавляется к клиентскому трафику: это другой этап доставки, а не дополнительные байты, отправленные пользователям. Monitoring отдаёт скорости в байтах/секунду; приложение интегрирует их и кэширует объём. История метрик доступна только в пределах периода хранения Monitoring, поэтому первичная синхронизация охватывает доступное окно.

После входа аккаунты можно добавлять и редактировать через кнопку «Добавить аккаунт» или «Изменить». Укажите название, Billing ID, дату гранта, пары Cloud ID/Folder ID (по одной на строку, через запятую) и JSON-ключ сервисного аккаунта. Ключи и изменяемая конфигурация хранятся в `data/` на сервере, браузеру ключ не передаётся. Назначьте нужные роли до сохранения аккаунта.

## Развёртывание на Ubuntu 24.04 + Docker Compose

Ниже предполагается, что DNS-запись `yc-monitor.getcyphra.cloud` уже указывает на публичный IP сервера, а порты 80 и 443 открыты.

1. Скопируйте содержимое этой папки на сервер в `/opt/yc-monitor`.
2. На сервере создайте папку для ключа и передайте скачанный авторизованный ключ по защищённому каналу. Не вставляйте JSON в `.env`, конфигурацию Nginx или Git:

   ```bash
   sudo mkdir -p /opt/yc-monitor/secrets /opt/yc-monitor/data
   sudo install -o 1000 -g 1000 -m 600 /path/to/yc-cloud-boreas-209-key.json /opt/yc-monitor/secrets/yc-cloud-boreas-209-key.json
   sudo chown -R 1000:1000 /opt/yc-monitor/data
   ```

   Если имя скачанного файла другое, можно переименовать его при `install`. Путь назначения должен совпасть с `serviceAccountKeyFile` в конфигурации.

3. Настройте пароль приложения:

   ```bash
   cd /opt/yc-monitor
   cp .env.example .env
   nano .env
   ```

   Задайте уникальный длинный пароль в `DASHBOARD_PASSWORD`. Файл `.env` не публикуйте и не добавляйте в Git.

4. Соберите и запустите контейнер:

   ```bash
   docker compose up -d --build
   docker compose logs -f yc-monitor
   ```

   Приложение доступно только локально на сервере по `127.0.0.1:3000`; наружу его публикует Nginx.

5. Создайте конфигурацию Nginx, например `/etc/nginx/sites-available/yc-monitor.getcyphra.cloud`:

   ```nginx
   server {
       listen 80;
       server_name yc-monitor.getcyphra.cloud;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

   Включите сайт и проверьте конфигурацию:

   ```bash
   sudo ln -s /etc/nginx/sites-available/yc-monitor.getcyphra.cloud /etc/nginx/sites-enabled/yc-monitor.getcyphra.cloud
   sudo nginx -t && sudo systemctl reload nginx
   ```

6. Выпустите и подключите сертификат:

   ```bash
   sudo certbot --nginx -d yc-monitor.getcyphra.cloud
   ```

7. Откройте `https://yc-monitor.getcyphra.cloud` и войдите с именем/паролем из `.env`.

## Обновления и ограничения источников

- CDN-ресурсы и метрики опрашиваются раз в минуту; сама метрика CDN в Monitoring обычно обновляется примерно раз в три минуты. Исторический трафик рассчитывается по точкам метрики и может немного отличаться от отображения в консоли — перед подключением остальных аккаунтов сравните результат на одном аккаунте.
- Yandex Cloud публикует для CDN скорости передачи (`edge.bytes_sent`, байт/с), а не готовый счётчик байтов; приложение интегрирует эти точки и сохраняет накопленный результат в `data/cache.json`. Сумма для пользователей отображает только доставку клиентам (`edge.bytes_sent`), а загрузка из источников (`origin.bytes_fetched`) остаётся отдельной диагностической величиной. Историческая часть при первом запуске зависит от доступного в Monitoring периода.
- Billing Usage API имеет лимит один отчётный запрос в минуту на IP. Backend соблюдает лимит и обновляет биллинг аккаунтов по очереди. Поэтому при нескольких billing accounts каждый отдельный отчёт будет обновляться реже минуты. Кэш сохраняется в `data/cache.json` при перезапуске контейнера.
- Billing API может пересчитывать отчётные данные. Остаток считается из поля грантового кредита, а не из общего баланса платежного аккаунта.
- Первый запуск может занять несколько минут: приложение начинает собирать каталог CDN и очередные отчёты биллинга.
- При ошибке `EACCES` в `cache.json` проверьте владельца bind mount и исправьте права командой `sudo chown -R 1000:1000 /opt/yc-monitor/data`, затем пересоздайте контейнер.

Полезная документация: [Billing Usage API](https://yandex.cloud/ru/docs/billing/operations/get-charges-via-api), [метрики Cloud CDN](https://yandex.cloud/ru/docs/monitoring/metrics-ref/cdn-ref), [список CDN-ресурсов API](https://yandex.cloud/ru/docs/cdn/api-ref/Resource/list), [авторизованные ключи](https://yandex.cloud/ru/docs/iam/operations/authentication/manage-authorized-keys).

## Проверка состояния

```bash
docker compose ps
docker compose logs --tail=100 yc-monitor
curl -fsS http://127.0.0.1:3000/healthz
```

`/healthz` используется для проверки контейнера и не возвращает данные облака. Остальные страницы защищены HTTP Basic Auth.
