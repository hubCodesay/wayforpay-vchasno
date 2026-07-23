import crypto from "node:crypto";
import express from "express";

const app = express();

const PORT = Number(process.env.PORT) || 3000;

const VCHASNO_API_URL =
  "https://kasa.vchasno.ua/api/v3/fiscal/execute";

/*
|--------------------------------------------------------------------------
| Тимчасовий захист від повторної обробки в межах одного запуску сервера
|--------------------------------------------------------------------------
*/

const processedOrders = new Set();
const processingOrders = new Map();

/*
|--------------------------------------------------------------------------
| Допоміжні функції
|--------------------------------------------------------------------------
*/

function roundMoney(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(`Некоректне числове значення: ${value}`);
  }

  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function createHmacMd5(value, secretKey) {
  return crypto
    .createHmac("md5", secretKey)
    .update(String(value), "utf8")
    .digest("hex");
}

function signaturesMatch(receivedSignature, expectedSignature) {
  const received = Buffer.from(
    String(receivedSignature || "").toLowerCase(),
    "utf8"
  );

  const expected = Buffer.from(
    String(expectedSignature || "").toLowerCase(),
    "utf8"
  );

  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected)
  );
}

function parseWayForPayBody(body) {
  const rawBody = Buffer.isBuffer(body)
    ? body.toString("utf8").trim()
    : String(body || "").trim();

  if (!rawBody) {
    throw new Error("WayForPay надіслав порожній callback");
  }

  /*
   * Основний варіант: WayForPay надсилає JSON,
   * навіть якщо Content-Type визначений некоректно.
   */
  try {
    return JSON.parse(rawBody);
  } catch {
    // Продовжуємо альтернативний розбір.
  }

  /*
   * Запасний варіант: весь JSON міг бути переданий
   * як ключ application/x-www-form-urlencoded.
   */
  const params = new URLSearchParams(rawBody);

  for (const [key, value] of params.entries()) {
    const candidates = [key, value];

    for (const candidate of candidates) {
      if (!candidate) continue;

      try {
        const parsed = JSON.parse(candidate);

        if (
          parsed &&
          typeof parsed === "object" &&
          parsed.orderReference
        ) {
          return parsed;
        }
      } catch {
        // Перевіряємо наступне значення.
      }
    }
  }

  throw new Error(
    `Не вдалося розібрати callback WayForPay: ${rawBody.slice(0, 300)}`
  );
}

function normalizeProducts(products) {
  let value = products;

  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error("Поле products містить некоректний JSON");
    }
  }

  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      "WayForPay не передав список товарів у полі products"
    );
  }

  return value;
}

function createProductCode(orderReference, index) {
  return crypto
    .createHash("sha1")
    .update(`${orderReference}:${index}`)
    .digest("hex")
    .slice(0, 16);
}

function validateEnvironment() {
  const requiredVariables = [
    "WAYFORPAY_MERCHANT_ACCOUNT",
    "WAYFORPAY_SECRET_KEY",
    "VCHASNO_TOKEN",
    "VCHASNO_DEVICE"
  ];

  const missingVariables = requiredVariables.filter(
    (variableName) => !process.env[variableName]
  );

  if (missingVariables.length > 0) {
    throw new Error(
      `Відсутні Railway Variables: ${missingVariables.join(", ")}`
    );
  }
}

function validateWayForPaySignature(data) {
  const merchantAccount =
    process.env.WAYFORPAY_MERCHANT_ACCOUNT;

  const secretKey =
    process.env.WAYFORPAY_SECRET_KEY;

  if (data.merchantAccount !== merchantAccount) {
    throw new Error("Некоректний merchantAccount");
  }

  const signatureString = [
    data.merchantAccount,
    data.orderReference,
    data.amount,
    data.currency,
    data.authCode || "",
    data.cardPan || "",
    data.transactionStatus,
    data.reasonCode
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
    throw new Error("Некоректний підпис WayForPay");
  }
}

function createVchasnoPayload(data) {
  const products = normalizeProducts(data.products);

  const paymentType = Number(
    process.env.VCHASNO_PAYMENT_TYPE || 16
  );

  const taxGroup = Number(
    process.env.VCHASNO_TAX_GROUP || 2
  );

  const paymentSum = roundMoney(data.amount);

  const rows = products.map((product, index) => {
    const name = String(product?.name || "").trim();
    const count = Number(product?.count || 1);
    const price = roundMoney(product?.price);

    if (!name) {
      throw new Error(
        `Не вказана назва товару №${index + 1}`
      );
    }

    if (!Number.isFinite(count) || count <= 0) {
      throw new Error(
        `Некоректна кількість товару "${name}"`
      );
    }

    if (price <= 0) {
      throw new Error(
        `Некоректна ціна товару "${name}"`
      );
    }

    const cost = roundMoney(price * count);

    return {
      code: createProductCode(
        data.orderReference,
        index
      ),
      name,
      cnt: count,
      price,
      cost,
      disc: 0,
      taxgrp: taxGroup
    };
  });

  const productsSum = roundMoney(
    rows.reduce((total, row) => total + row.cost, 0)
  );

  if (Math.abs(productsSum - paymentSum) > 0.01) {
    throw new Error(
      `Сума товарів ${productsSum} не дорівнює сумі оплати ${paymentSum}`
    );
  }

  const userinfo = {};

  if (data.email) {
    userinfo.email = String(data.email).trim();
  }

  if (data.phone) {
    userinfo.phone = String(data.phone).trim();
  }

  return {
    source: "WAYFORPAY",

    // Фіскальний номер тестової або бойової каси.
    device: String(process.env.VCHASNO_DEVICE),

    // Унікальний номер замовлення.
    tag: String(data.orderReference),

    userinfo,

    fiscal: {
      // 1 — чек продажу.
      task: 1,

      cashier:
        process.env.VCHASNO_CASHIER || "WayForPay",

      receipt: {
        sum: paymentSum,

        rows,

        pays: [
          {
            // 16 — Інтернет еквайринг.
            type: paymentType,
            sum: paymentSum
          }
        ]
      }
    }
  };
}

async function fiscalizeInVchasno(data) {
  const payload = createVchasnoPayload(data);

  console.log(
    "Надсилаємо чек у Вчасно.Каса:",
    JSON.stringify(
      {
        orderReference: data.orderReference,
        amount: data.amount,
        products: data.products
      },
      null,
      2
    )
  );

  const response = await fetch(VCHASNO_API_URL, {
    method: "POST",

    headers: {
      Authorization: process.env.VCHASNO_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json"
    },

    body: JSON.stringify(payload),

    signal: AbortSignal.timeout(30000)
  });

  const responseText = await response.text();

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
    "Відповідь Вчасно.Каса:",
    JSON.stringify(result, null, 2)
  );

  const resultCode =
    result.res === undefined
      ? null
      : Number(result.res);

  const taskStatus =
    result.task_status === undefined
      ? null
      : Number(result.task_status);

  if (!response.ok) {
    throw new Error(
      `Вчасно.Каса HTTP ${response.status}: ${JSON.stringify(result)}`
    );
  }

  if (
    resultCode !== null &&
    resultCode !== 0
  ) {
    throw new Error(
      `Вчасно.Каса повернула помилку ${resultCode}: ${
        result.errortxt || JSON.stringify(result)
      }`
    );
  }

  if (taskStatus === 3) {
    throw new Error(
      `Помилка виконання завдання Вчасно.Каса: ${
        result.errortxt || JSON.stringify(result)
      }`
    );
  }

  return result;
}

async function processApprovedPayment(data) {
  const orderReference = String(
    data.orderReference
  );

  if (processedOrders.has(orderReference)) {
    console.log(
      `Замовлення ${orderReference} вже було оброблене`
    );

    return {
      duplicate: true
    };
  }

  if (processingOrders.has(orderReference)) {
    console.log(
      `Замовлення ${orderReference} вже обробляється`
    );

    return processingOrders.get(orderReference);
  }

  const processingPromise = fiscalizeInVchasno(data)
    .then((result) => {
      processedOrders.add(orderReference);
      return result;
    })
    .finally(() => {
      processingOrders.delete(orderReference);
    });

  processingOrders.set(
    orderReference,
    processingPromise
  );

  return processingPromise;
}

function createWayForPayResponse(orderReference) {
  const status = "accept";
  const time = Math.floor(Date.now() / 1000);

  const signatureString = [
    orderReference,
    status,
    time
  ].join(";");

  const signature = createHmacMd5(
    signatureString,
    process.env.WAYFORPAY_SECRET_KEY
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
| Перевірка роботи сервера
|--------------------------------------------------------------------------
*/

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "WayForPay → Вчасно.Каса",
    timestamp: new Date().toISOString()
  });
});

/*
|--------------------------------------------------------------------------
| Callback WayForPay
|--------------------------------------------------------------------------
|
| Важливо: express.raw повинен стояти саме тут,
| до express.json та express.urlencoded.
|
*/

app.post(
  "/webhooks/wayforpay",
  express.raw({
    type: "*/*",
    limit: "300kb"
  }),
  async (req, res) => {
    let data;

    try {
      validateEnvironment();

      data = parseWayForPayBody(req.body);

      console.log(
        "Отримано callback WayForPay:",
        JSON.stringify(
          {
            merchantAccount: data.merchantAccount,
            orderReference: data.orderReference,
            amount: data.amount,
            currency: data.currency,
            transactionStatus:
              data.transactionStatus,
            reasonCode: data.reasonCode,
            products: data.products
          },
          null,
          2
        )
      );

      if (!data.orderReference) {
        throw new Error(
          "У callback відсутній orderReference"
        );
      }

      validateWayForPaySignature(data);

      /*
       * Неуспішні та проміжні статуси підтверджуємо,
       * але чек для них не створюємо.
       */
      if (
        data.transactionStatus !== "Approved"
      ) {
        console.log(
          `Платіж ${data.orderReference}: ${data.transactionStatus}`
        );

        return res.json(
          createWayForPayResponse(
            data.orderReference
          )
        );
      }

      if (
        String(data.currency).toUpperCase() !== "UAH"
      ) {
        throw new Error(
          `Непідтримувана валюта: ${data.currency}`
        );
      }

      const fiscalResult =
        await processApprovedPayment(data);

      console.log(
        "Оплату успішно фіскалізовано:",
        JSON.stringify(
          {
            orderReference:
              data.orderReference,
            result: fiscalResult
          },
          null,
          2
        )
      );

      return res.json(
        createWayForPayResponse(
          data.orderReference
        )
      );
    } catch (error) {
      console.error(
        "Помилка обробки callback:",
        error instanceof Error
          ? error.message
          : error
      );

      /*
       * Не повертаємо accept, якщо чек не створено.
       * WayForPay зможе повторити callback.
       */
      return res.status(502).json({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "Unknown error",
        orderReference:
          data?.orderReference || null
      });
    }
  }
);

/*
|--------------------------------------------------------------------------
| Парсери для інших маршрутів
|--------------------------------------------------------------------------
*/

app.use(
  express.json({
    limit: "300kb"
  })
);

app.use(
  express.urlencoded({
    extended: false,
    limit: "300kb"
  })
);

/*
|--------------------------------------------------------------------------
| 404
|--------------------------------------------------------------------------
*/

app.use((_req, res) => {
  res.status(404).json({
    error: "Route not found"
  });
});

/*
|--------------------------------------------------------------------------
| Запуск
|--------------------------------------------------------------------------
*/

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Сервер запущено на порту ${PORT}`
  );
});
