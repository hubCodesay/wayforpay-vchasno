import crypto from "node:crypto";
import express from "express";

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT) || 3000;

const BUILD_ID = "no-userinfo-v8-20260723";


const WAYFORPAY_MERCHANT_ACCOUNT =
  "artur_dron_webflow_io";

const VCHASNO_API_URL =
  "https://kasa.vchasno.ua/api/v3/fiscal/execute";

const PAYMENT_TYPE = Number(
  process.env.VCHASNO_PAYMENT_TYPE || 16
);

const TAX_GROUP = Number(
  process.env.VCHASNO_TAX_GROUP || 2
);

/*
|--------------------------------------------------------------------------
| Тимчасовий захист від повторів
|--------------------------------------------------------------------------
|
| Працює до перезапуску Railway.
| Для бойової версії пізніше потрібна база даних.
|
*/

const processedOrders = new Set();
const processingOrders = new Map();

/*
|--------------------------------------------------------------------------
| Загальні функції
|--------------------------------------------------------------------------
*/

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    throw new Error(
      `У Railway відсутня змінна ${name}`
    );
  }

  return value;
}

function roundMoney(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(
      `Некоректне числове значення: ${value}`
    );
  }

  return (
    Math.round(
      (number + Number.EPSILON) * 100
    ) / 100
  );
}

function createHmacMd5(value, secretKey) {
  return crypto
    .createHmac("md5", secretKey)
    .update(String(value), "utf8")
    .digest("hex");
}

function signaturesMatch(received, expected) {
  const receivedBuffer = Buffer.from(
    String(received || "")
      .trim()
      .toLowerCase(),
    "utf8"
  );

  const expectedBuffer = Buffer.from(
    String(expected || "")
      .trim()
      .toLowerCase(),
    "utf8"
  );

  return (
    receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(
      receivedBuffer,
      expectedBuffer
    )
  );
}

function tryParseJson(value) {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);

    return parsed && typeof parsed === "object"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/*
|--------------------------------------------------------------------------
| Розбір callback WayForPay
|--------------------------------------------------------------------------
*/

function parseWayForPayBody(body) {
  const rawBody = Buffer.isBuffer(body)
    ? body.toString("utf8").trim()
    : String(body || "").trim();

  if (!rawBody) {
    throw new Error(
      "WayForPay надіслав порожній callback"
    );
  }

  const directJson = tryParseJson(rawBody);

  if (directJson?.orderReference) {
    return directJson;
  }

  try {
    const decoded = decodeURIComponent(
      rawBody.replace(/\+/g, "%20")
    );

    const decodedJson = tryParseJson(decoded);

    if (decodedJson?.orderReference) {
      return decodedJson;
    }
  } catch {
    // Переходимо до наступного способу.
  }

  const params = new URLSearchParams(rawBody);

  for (const [key, value] of params.entries()) {
    for (const candidate of [key, value]) {
      const parsed = tryParseJson(candidate);

      if (parsed?.orderReference) {
        return parsed;
      }

      try {
        const decodedCandidate =
          decodeURIComponent(candidate);

        const decodedParsed =
          tryParseJson(decodedCandidate);

        if (decodedParsed?.orderReference) {
          return decodedParsed;
        }
      } catch {
        // Перевіряємо наступне значення.
      }
    }
  }

  throw new Error(
    `Не вдалося розібрати callback: ${rawBody.slice(0, 300)}`
  );
}

/*
|--------------------------------------------------------------------------
| Перевірка WayForPay
|--------------------------------------------------------------------------
*/

function validateWayForPayCallback(data) {
  const receivedMerchant = String(
    data.merchantAccount || ""
  ).trim();

  if (
    receivedMerchant !==
    WAYFORPAY_MERCHANT_ACCOUNT
  ) {
    throw new Error(
      `Некоректний merchantAccount: ${receivedMerchant}`
    );
  }

  const secretKey = requiredEnv(
    "WAYFORPAY_SECRET_KEY"
  );

  const signatureString = [
    receivedMerchant,
    String(data.orderReference || ""),
    String(data.amount ?? ""),
    String(data.currency || ""),
    String(data.authCode || ""),
    String(data.cardPan || ""),
    String(data.transactionStatus || ""),
    String(data.reasonCode ?? "")
  ].join(";");

  const expectedSignature = createHmacMd5(
    signatureString,
    secretKey
  );

  if (
    !signaturesMatch(
      data.merchantSignature,
      expectedSignature
    )
  ) {
    throw new Error(
      "Некоректний підпис WayForPay"
    );
  }

  console.log(
    `[${BUILD_ID}] Підпис WayForPay правильний`
  );
}

/*
|--------------------------------------------------------------------------
| Формування товарів
|--------------------------------------------------------------------------
*/

function normalizeProducts(products) {
  let result = products;

  if (typeof result === "string") {
    result = tryParseJson(result);
  }

  if (
    !Array.isArray(result) ||
    result.length === 0
  ) {
    throw new Error(
      "WayForPay не передав список товарів"
    );
  }

  return result;
}

function createProductCode(orderReference, index) {
  return crypto
    .createHash("sha1")
    .update(`${orderReference}:${index}`)
    .digest("hex")
    .slice(0, 16);
}

/*
|--------------------------------------------------------------------------
| Формування запиту у Вчасно
|--------------------------------------------------------------------------
*/

function createVchasnoPayload(data) {
  const device = requiredEnv(
    "VCHASNO_DEVICE"
  );

  const paymentSum = roundMoney(
    data.amount
  );

  if (paymentSum <= 0) {
    throw new Error(
      "Сума платежу має бути більшою за нуль"
    );
  }

  const products = normalizeProducts(
    data.products
  );

  const rows = products.map(
    (product, index) => {
      const name = String(
        product?.name || ""
      ).trim();

      const count = Number(
        product?.count ?? 1
      );

      const price = roundMoney(
        product?.price
      );

      if (!name) {
        throw new Error(
          `Відсутня назва товару №${index + 1}`
        );
      }

      if (
        !Number.isFinite(count) ||
        count <= 0
      ) {
        throw new Error(
          `Некоректна кількість товару: ${name}`
        );
      }

      if (price <= 0) {
        throw new Error(
          `Некоректна ціна товару: ${name}`
        );
      }

      return {
        code: createProductCode(
          data.orderReference,
          index
        ),

        name,
        cnt: count,
        price,

        cost: roundMoney(
          price * count
        ),

        disc: 0,
        disc_type: 0,
        taxgrp: TAX_GROUP
      };
    }
  );

  const productsSum = roundMoney(
    rows.reduce(
      (sum, row) => sum + row.cost,
      0
    )
  );

  if (
    Math.abs(
      productsSum - paymentSum
    ) > 0.01
  ) {
    throw new Error(
      `Сума товарів ${productsSum} не дорівнює оплаті ${paymentSum}`
    );
  }

  /*
   * Навмисно відсутні:
   *
   * userinfo
   * email
   * phone
   * SMS
   * Viber
   */
  return {
    ver: 6,
    source: "WAYFORPAY",
    device,

    tag: String(
      data.orderReference
    ).trim(),

    type: 1,

    fiscal: {
      task: 1,

      receipt: {
        sum: paymentSum,
        disc: 0,
        disc_type: 0,

        rows,

        pays: [
          {
            type: PAYMENT_TYPE,
            sum: paymentSum,
            change: 0
          }
        ]
      }
    }
  };
}

function assertNoNotifications(payload) {
  const serialized = JSON.stringify(payload);

  const forbiddenFields = [
    '"userinfo"',
    '"email"',
    '"phone"',
    '"recipient"',
    '"channel"'
  ];

  const foundField = forbiddenFields.find(
    (field) => serialized.includes(field)
  );

  if (foundField) {
    throw new Error(
      `Заборонене поле сповіщення потрапило в запит: ${foundField}`
    );
  }

  console.log(
    `[${BUILD_ID}] Перевірка сповіщень: ВІДСУТНІ`
  );

  return serialized;
}

/*
|--------------------------------------------------------------------------
| Надсилання у Вчасно.Каса
|--------------------------------------------------------------------------
*/

async function fiscalizeInVchasno(data) {
  const token = requiredEnv(
    "VCHASNO_TOKEN"
  );

  const payload = createVchasnoPayload(data);

  /*
   * Додаткове примусове очищення.
   * Навіть якщо код вище колись змінять.
   */
  delete payload.userinfo;
  delete payload.email;
  delete payload.phone;

  const requestBody =
    assertNoNotifications(payload);

  console.log(
    `[${BUILD_ID}] Надсилаємо чек у Вчасно.Каса:`,
    JSON.stringify(payload, null, 2)
  );

  const response = await fetch(
    VCHASNO_API_URL,
    {
      method: "POST",

      headers: {
        Authorization: token,
        "Content-Type": "application/json",
        Accept: "application/json"
      },

      body: requestBody,

      signal:
        AbortSignal.timeout(30000)
    }
  );

  const responseText =
    await response.text();

  let result;

  try {
    result = responseText
      ? JSON.parse(responseText)
      : {};
  } catch {
    result = {
      raw: responseText
    };
  }

  console.log(
    `[${BUILD_ID}] HTTP статус Вчасно:`,
    response.status
  );

  console.log(
    `[${BUILD_ID}] Відповідь Вчасно.Каса:`,
    JSON.stringify(result, null, 2)
  );

  if (!response.ok) {
    throw new Error(
      `Вчасно HTTP ${response.status}: ${JSON.stringify(result)}`
    );
  }

  const resultCode =
    result.res === undefined
      ? null
      : Number(result.res);

  if (
    resultCode !== null &&
    resultCode !== 0
  ) {
    throw new Error(
      `Вчасно res=${resultCode}: ${
        result.errortxt ||
        JSON.stringify(result)
      }`
    );
  }

  if (
    Number(result.task_status) === 3
  ) {
    throw new Error(
      `Вчасно відхилила чек: ${
        result.errortxt ||
        JSON.stringify(result)
      }`
    );
  }

  return result;
}

/*
|--------------------------------------------------------------------------
| Захист від одночасних повторів
|--------------------------------------------------------------------------
*/

async function processApprovedPayment(data) {
  const orderReference = String(
    data.orderReference
  ).trim();

  if (processedOrders.has(orderReference)) {
    console.log(
      `[${BUILD_ID}] ${orderReference} уже оброблено`
    );

    return {
      duplicate: true,
      orderReference
    };
  }

  if (processingOrders.has(orderReference)) {
    return processingOrders.get(
      orderReference
    );
  }

  const promise = fiscalizeInVchasno(data)
    .then((result) => {
      processedOrders.add(
        orderReference
      );

      return result;
    })
    .finally(() => {
      processingOrders.delete(
        orderReference
      );
    });

  processingOrders.set(
    orderReference,
    promise
  );

  return promise;
}

/*
|--------------------------------------------------------------------------
| Відповідь WayForPay
|--------------------------------------------------------------------------
*/

function createWayForPayAcceptResponse(
  orderReference
) {
  const secretKey = requiredEnv(
    "WAYFORPAY_SECRET_KEY"
  );

  const status = "accept";

  const time = Math.floor(
    Date.now() / 1000
  );

  const signature = createHmacMd5(
    [
      orderReference,
      status,
      time
    ].join(";"),
    secretKey
  );

  return {
    orderReference,
    status,
    time,
    signature
  };
}

/*
|--------------------------------------------------------------------------
| Перевірка версії
|--------------------------------------------------------------------------
*/

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    build: BUILD_ID,

    service:
      "WayForPay → Вчасно.Каса",

    notifications: false,

    merchantAccount:
      WAYFORPAY_MERCHANT_ACCOUNT,

    wayforpaySecretConfigured:
      Boolean(
        process.env.WAYFORPAY_SECRET_KEY
      ),

    vchasnoTokenConfigured:
      Boolean(
        process.env.VCHASNO_TOKEN
      ),

    vchasnoDeviceConfigured:
      Boolean(
        process.env.VCHASNO_DEVICE
      ),

    timestamp:
      new Date().toISOString()
  });
});

/*
|--------------------------------------------------------------------------
| Callback WayForPay
|--------------------------------------------------------------------------
*/

app.post(
  "/webhooks/wayforpay",

  express.raw({
    type: "*/*",
    limit: "500kb"
  }),

  async (req, res) => {
    let data = null;

    try {
      data = parseWayForPayBody(
        req.body
      );

      console.log(
        `[${BUILD_ID}] Callback WayForPay:`,
        JSON.stringify(
          {
            orderReference:
              data.orderReference,

            amount:
              data.amount,

            currency:
              data.currency,

            transactionStatus:
              data.transactionStatus,

            reasonCode:
              data.reasonCode,

            products:
              data.products
          },
          null,
          2
        )
      );

      if (!data.orderReference) {
        throw new Error(
          "Відсутній orderReference"
        );
      }

      validateWayForPayCallback(data);

      /*
       * Неуспішні платежі підтверджуємо,
       * але чек не створюємо.
       */
      if (
        String(
          data.transactionStatus
        ) !== "Approved"
      ) {
        console.log(
          `[${BUILD_ID}] Платіж ${data.orderReference}: ${data.transactionStatus}`
        );

        return res.json(
          createWayForPayAcceptResponse(
            data.orderReference
          )
        );
      }

      if (
        String(
          data.currency || ""
        ).toUpperCase() !== "UAH"
      ) {
        throw new Error(
          `Непідтримувана валюта: ${data.currency}`
        );
      }

      const fiscalResult =
        await processApprovedPayment(
          data
        );

      console.log(
        `[${BUILD_ID}] ЧЕК УСПІШНО ФІСКАЛІЗОВАНО:`,
        JSON.stringify(
          {
            orderReference:
              data.orderReference,

            fiscalResult
          },
          null,
          2
        )
      );

      return res.json(
        createWayForPayAcceptResponse(
          data.orderReference
        )
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      console.error(
        `[${BUILD_ID}] Помилка:`,
        message
      );

      /*
       * Не підтверджуємо callback,
       * доки чек не створений.
       */
      return res.status(502).json({
        status: "error",
        build: BUILD_ID,
        message,

        orderReference:
          data?.orderReference || null
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Інші маршрути
|--------------------------------------------------------------------------
*/

app.use(
  express.json({
    limit: "500kb"
  })
);

app.use(
  express.urlencoded({
    extended: false,
    limit: "500kb"
  })
);

app.use((_req, res) => {
  res.status(404).json({
    error: "Route not found",
    build: BUILD_ID
  });
});

/*
|--------------------------------------------------------------------------
| Запуск код
|--------------------------------------------------------------------------
*/

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `[${BUILD_ID}] Сервер запущено на порту ${PORT}`
    );

    console.log(
      `[${BUILD_ID}] Конфігурація:`,
      {
        merchantAccount:
          WAYFORPAY_MERCHANT_ACCOUNT,

        wayforpaySecretConfigured:
          Boolean(
            process.env
              .WAYFORPAY_SECRET_KEY
          ),

        vchasnoTokenConfigured:
          Boolean(
            process.env
              .VCHASNO_TOKEN
          ),

        vchasnoDevice:
          String(
            process.env
              .VCHASNO_DEVICE ||
              "НЕ ЗАДАНО"
          ),

        paymentType:
          PAYMENT_TYPE,

        taxGroup:
          TAX_GROUP,

        notifications:
          false
      }
    );
  }
);

