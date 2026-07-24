# WayForPay → Вчасно.Каса

## Для чого цей репозиторій

Цей репозиторій містить сервер-посередник між:

1. Сайтом
2. WayForPay
3. Вчасно.Каса

Схема роботи:

Сайт → WayForPay → Railway → Вчасно.Каса

Після успішної оплати WayForPay надсилає інформацію про замовлення на Railway. Сервер перевіряє підпис WayForPay, формує чек і передає його у Вчасно.Каса.

## Адреса сервера

Основна адреса Railway:

https://wayforpay-vchasno-production-835d.up.railway.app

Перевірка роботи сервера:

https://wayforpay-vchasno-production-835d.up.railway.app/

Webhook для WayForPay:

https://wayforpay-vchasno-production-835d.up.railway.app/webhooks/wayforpay

Webhook не відкривається як звичайна сторінка у браузері, тому що він приймає POST-запити від WayForPay.

При відкритті webhook у браузері може з’явитися:

{
  "error": "Route not found"
}

Це нормально.

## Де вказаний webhook

У кабінеті WayForPay:

Налаштування магазину → Повідомлення → Service URL

У полі Service URL має бути:

https://wayforpay-vchasno-production-835d.up.railway.app/webhooks/wayforpay

Після зміни адреси потрібно натиснути «Зберегти».

## Основні файли репозиторію

### index.js

Головний файл сервера.

Він:

- приймає callback від WayForPay;
- перевіряє підпис платежу;
- перевіряє статус Approved;
- отримує назву, ціну та кількість товарів;
- створює чек у Вчасно.Каса;
- не надсилає SMS, email або Viber-повідомлення;
- повертає WayForPay підтвердження прийняття callback.

Поточна версія коду:

no-userinfo-v8-20260723

### package.json

Містить налаштування Node.js і команду запуску:

node index.js

## Де зберігаються секретні дані

Секретні ключі не можна записувати в index.js або завантажувати в GitHub.

Вони зберігаються в Railway:

Service → Variables

Потрібні змінні:

WAYFORPAY_SECRET_KEY
VCHASNO_TOKEN
VCHASNO_DEVICE
VCHASNO_PAYMENT_TYPE
VCHASNO_TAX_GROUP

Приклад структури:

WAYFORPAY_SECRET_KEY=секретний_ключ_WayForPay
VCHASNO_TOKEN=токен_Вчасно.Каса
VCHASNO_DEVICE=номер_каси
VCHASNO_PAYMENT_TYPE=16
VCHASNO_TAX_GROUP=2

Значення секретних ключів не можна надсилати стороннім людям або публікувати у GitHub.

## Як оновити код

1. Відкрити репозиторій GitHub.
2. Відкрити файл index.js.
3. Натиснути кнопку з олівцем — Edit this file.
4. Внести зміни.
5. Натиснути Commit changes.
6. Обрати Commit directly to the main branch.
7. Після коміту Railway автоматично створить новий deployment.

У Railway потрібно перевірити:

Deployments → новий deployment → Active

Не потрібно змінювати код через Railway Console. Зміни в Console можуть зникнути після перезапуску контейнера.

## Підключення GitHub до Railway

У Railway:

Service → Settings → Source

Має бути:

Repository: wayforpay-vchasno  
Branch: main  
Root Directory: порожньо

Root Directory потрібно залишати порожнім, тому що index.js і package.json лежать у корені репозиторію.

## Як перевірити, що запущений правильний код

Відкрити:

https://wayforpay-vchasno-production-835d.up.railway.app/

Правильна відповідь:

{
  "status": "ok",
  "build": "no-userinfo-v8-20260723",
  "service": "WayForPay → Вчасно.Каса",
  "notifications": false,
  "wayforpaySecretConfigured": true,
  "vchasnoTokenConfigured": true,
  "vchasnoDeviceConfigured": true
}

Значення:

- build — версія запущеного коду;
- notifications: false — email, SMS і Viber не надсилаються;
- true біля ключів — Railway бачить потрібні змінні.

## Як перевірити оплату

Після тестової оплати потрібно відкрити:

Railway → Service → Deployments → Active deployment → Logs

У правильних логах має бути:

[no-userinfo-v8-20260723] Callback WayForPay
[no-userinfo-v8-20260723] Підпис WayForPay правильний
[no-userinfo-v8-20260723] Перевірка сповіщень: ВІДСУТНІ
[no-userinfo-v8-20260723] HTTP статус Вчасно: 200
[no-userinfo-v8-20260723] ЧЕК УСПІШНО ФІСКАЛІЗОВАНО

Головний показник успіху:

res: 0

Це означає, що Вчасно.Каса успішно створила чек.

## Де переглянути створений чек

У кабінеті Вчасно.Каса потрібно відкрити розділ «Чеки».

У списку відображаються:

- дата та час;
- сума;
- тип операції;
- внутрішній номер;
- фіскальний номер.

Щоб побачити назву товару, кількість і ціну, потрібно натиснути:

«Переглянути чек»

Усередині буде:

- назва товару;
- кількість;
- ціна;
- загальна сума;
- спосіб оплати.

## Тестова і реальна каса

Коли код документа починається з:

TEST_

це означає, що використовується тестова каса.

Наприклад:

TEST_TEzP2_n44VH0ng

Для переходу на реальну касу потрібно змінити в Railway:

VCHASNO_TOKEN
VCHASNO_DEVICE

На токен і фіскальний номер реальної каси.

Після зміни потрібно зробити тестову оплату на невелику суму та перевірити:

res: 0

У реальному чеку код документа не повинен починатися з TEST_.

## Важливі правила

1. Не видаляти репозиторій GitHub.
2. Не видаляти Railway-проєкт, поки інтеграція використовується.
3. Не публікувати секретні ключі.
4. Не додавати email або phone у payload Вчасно.Каса, якщо не потрібні повідомлення.
5. Після зміни домену Railway обов’язково оновлювати Service URL у WayForPay.
6. Після зміни коду завжди перевіряти build на головній адресі сервера.
7. Для перевірки фіскалізації дивитися не лише HTTP 200, а саме res: 0.

## Поточний робочий результат

Інтеграція успішно:

- отримує успішні платежі WayForPay;
- перевіряє підпис;
- передає товар у Вчасно.Каса;
- створює чек;
- не надсилає Viber, SMS або email;
- повертає результат res: 0.
