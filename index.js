import crypto from "node:crypto";
import express from "express";

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT) || 3000;

/*
|--------------------------------------------------------------------------
| Налаштування
|--------------------------------------------------------------------------
*/

// merchantAccount не є секретом, тому фіксуємо його прямо тут.
const WAYFORPAY_MERCHANT_ACCOUNT = "artur_dron_webflow_io";

const VCHASNO_API_URL =
  process.env.VCHASNO_API_URL ||
  "https://kasa.vchasno.ua/api/v3/fiscal/execute";

const VCHASNO_PAYMENT_TYPE = Number(
  process.env.VCHASNO_PAYMENT_TYPE || 16
);

const VCHASNO_TAX_GROUP = Number(
  process.env.VCHASNO_TAX_GROUP || 2
);

/*
|--------------------------------------------------------------------------
| Тимчасовий захист від дублів
|--------------------------------------------------------------------------
|
| Працює до перезапуску Railway.
| Для бойового використання потім підключимо PostgreSQL.
|
*/

const processedOrders = new Set();
const processingOrders = new Map();

/*
|--------------------------------------------------------------------------
| Допоміжні функції
|--------------------------------------------------------------------------
*/

function getRequiredEnv(name) {
  const value = String(process.env[name] || "").trim();

  if (!value) {
    throw new Error(`У Railway відсутня змінна ${name}`);
  }

  return value;
}

function roundMoney(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    throw new Error(`Некоректне число: ${value}`);
  }

  return Math.round((number + Number.EPSILON) * 100) / 100;
}

function createHmacMd5(value, secretKey) {
  return crypto
    .createHmac("md5", secretKey)
    .update(String(value), "utf8")
    .digest("hex");
}

function signaturesMatch(receivedValue, expectedValue) {
  const received = Buffer.from(
    String(receivedValue || "").trim().toLowerCase(),
    "utf8"
  );

  const expected = Buffer.from(
    String(expectedValue || "").trim().toLowerCase(),
    "utf8"
  );

  return (
    received.length === expected.length &&
    crypto.timingSafeEqual(received, expected)
  );
}

function tryParseJson(value) {
  if (!value) return null;

  try {
    const parsed = JSON.parse(value);

    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
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
    throw new Error("WayForPay надіслав порожній callback");
  }

  // Нормальний JSON.
  const directJson = tryParseJson(rawBody);

  if (directJson?.orderReference) {
    return directJson;
  }

  // URL-encoded JSON.
  try {
    const decoded = decodeURIComponent(
      rawBody.replace(/\+/g, "%20")
    );

    const decodedJson = tryParseJson(decoded);

    if (decodedJson?.orderReference) {
      return decodedJson;
    }
  } catch {
    // Продовжуємо інші способи.
  }

  // Весь JSON міг потрапити як ключ form-urlencoded.
  const params = new URLSearchParams(rawBody);

  for (const [key, value] of params.entries()) {
    const candidates = [key, value];

    for (const candidate of candidates) {
      const parsed = tryParseJson(candidate);

      if (parsed?.orderReference) {
        return parsed;
      }

      try {
        const decodedCandidate = decodeURIComponent(candidate);
        const decodedParsed = tryParseJson(decodedCandidate);

        if (decodedParsed?.orderReference) {
          return decodedParsed;
        }
      } catch {
        // Перевіряємо наступне значення.
      }
    }
  }

  throw new Error(
    `Не вдалося розібрати callback: ${rawBody.slice(0, 250)}`
  );
}

/*
|--------------------------------------------------------------------------
| Перевірка WayForPay
|--------------------------------------------------------------------------
*/

function validateWayForPayCallback(data) {
  const receivedMerchantAccount = String(
    data.merchantAccount || ""
  ).trim();

  console.log("Перевірка merchantAccount:", {
    received: receivedMerchantAccount,
    expected: WAYFORPAY_MERCHANT_ACCOUNT,
    equal:
      receivedMerchantAccount === WAYFORPAY_MERCHANT_ACCOUNT
  });

  if (
    receivedMerchantAccount !== WAYFORPAY_MERCHANT_ACCOUNT
  ) {
    throw new Error(
      `Некоректний merchantAccount: ${receivedMerchantAccount}`
    );
  }

  const secretKey = getRequiredEnv(
    "WAYFORPAY_SECRET_KEY"
  );

  const signatureString = [
    receivedMerchantAccount,
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
    console.error("Підписи WayForPay не збігаються:", {
      received: data.merchantSignature,
      expected: expectedSignature,
      signatureString
    });

    throw new Error("Некоректний підпис WayForPay");
  }

  console.log("Підпис WayForPay правильний");
}

/*
|--------------------------------------------------------------------------
| Товари
|--------------------------------------------------------------------------
*/

function normalizeProducts(products) {
  let normalizedProducts = products;

  if (typeof normalizedProducts === "string") {
    normalizedProducts = tryParseJson(normalizedProducts);
  }

  if (
    !Array.isArray(normalizedProducts) ||
    normalizedProducts.length === 0
  ) {
    throw new Error(
      "WayForPay не передав список товарів"
    );
  }

  return normalizedProducts;
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
| Формування чека Вчасно.Каса
|--------------------------------------------------------------------------
*/

function createVchasnoPayload(data) {
  const device = getRequiredEnv("VCHASNO_DEVICE");

  const products = normalizeProducts(data.products);
  const paymentSum = roundMoney(data.amount);

  if (paymentSum <= 0) {
    throw new Error("Сума платежу повинна бути більшою за нуль");
  }

  const rows = products.map((product, index) => {
    const name = String(product?.name || "").trim();
    const count = Number(product?.count || 1);
    const price = roundMoney(product?.price);

    if (!name) {
      throw new Error(
        `Відсутня назва товару №${index + 1}`
      );
    }

    if (!Number.isFinite(count) || count <= 0) {
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
      cost: roundMoney(price * count),
      disc: 0,
      taxgrp: VCHASNO_TAX_GROUP
    };
  });

  const productsSum = roundMoney(
    rows.reduce((sum, row) => sum + row.cost, 0)
  );

  if (Math.abs(productsSum - paymentSum) > 0.01) {
    throw new Error(
      `Сума товарів ${productsSum} не дорівнює оплаті ${paymentSum}`
    );
  }



  return {
    ver: 6,
    source: "WAYFORPAY",
    device,
    tag: String(data.orderReference),
    type: 1,

    fiscal: {
      task: 1,

      receipt: {
        sum: paymentSum,
        rows,

        pays: [
          {
            type: VCHASNO_PAYMENT_TYPE,
            sum: paymentSum
          }
        ]
      }
    }
  };
}

/*
|--------------------------------------------------------------------------
| Відправлення у Вчасно.Каса
|--------------------------------------------------------------------------
*/

async function fiscalizeInVchasno(data) {
  const token = getRequiredEnv("VCHASNO_TOKEN");
  const payload = createVchasnoPayload(data);

  console.log(
    "Надсилаємо чек у Вчасно.Каса:",
    JSON.stringify(payload, null, 2)
  );

  const response = await fetch(VCHASNO_API_URL, {
    method: "POST",

    headers: {
      Authorization: token,
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

  console.log("HTTP статус Вчасно:", response.status);

  console.log(
    "Відповідь Вчасно.Каса:",
    JSON.stringify(result, null, 2)
  );

  if (!response.ok) {
    throw new Error(
      `Вчасно HTTP ${response.status}: ${JSON.stringify(result)}`
    );
  }

  if (
    result.res !== undefined &&
    Number(result.res) !== 0
  ) {
    throw new Error(
      `Вчасно res=${result.res}: ${
        result.errortxt || JSON.stringify(result)
      }`
    );
  }

  if (Number(result.task_status) === 3) {
    throw new Error(
      `Вчасно відхилила чек: ${
        result.errortxt || JSON.stringify(result)
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
      `Замовлення ${orderReference} уже оброблене`
    );

    return {
      duplicate: true,
      orderReference
    };
  }

  if (processingOrders.has(orderReference)) {
    console.log(
      `Замовлення ${orderReference} уже обробляється`
    );

    return processingOrders.get(orderReference);
  }

  const promise = fiscalizeInVchasno(data)
    .then((result) => {
      processedOrders.add(orderReference);
      return result;
    })
    .finally(() => {
      processingOrders.delete(orderReference);
    });

  processingOrders.set(orderReference, promise);

  return promise;
}

/*
|--------------------------------------------------------------------------
| Відповідь WayForPay
|--------------------------------------------------------------------------
*/

function createWayForPayAcceptResponse(orderReference) {
  const secretKey = getRequiredEnv(
    "WAYFORPAY_SECRET_KEY"
  );

  const status = "accept";
  const time = Math.floor(Date.now() / 1000);

  const signature = createHmacMd5(
    [orderReference, status, time].join(";"),
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
| Перевірка сервера
|--------------------------------------------------------------------------
*/

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    version: "vchasno-merchant-fix-3",
    service: "WayForPay → Вчасно.Каса",
    merchantAccount: WAYFORPAY_MERCHANT_ACCOUNT,
    wayforpaySecretConfigured: Boolean(
      process.env.WAYFORPAY_SECRET_KEY
    ),
    vchasnoTokenConfigured: Boolean(
      process.env.VCHASNO_TOKEN
    ),
    vchasnoDeviceConfigured: Boolean(
      process.env.VCHASNO_DEVICE
    ),
    timestamp: new Date().toISOString()
  });
});

/*
|--------------------------------------------------------------------------
| Callback WayForPay
|--------------------------------------------------------------------------
|
| Цей маршрут обов’язково має бути ДО express.json().
|
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
          "Відсутній orderReference"
        );
      }

      validateWayForPayCallback(data);

      /*
       * Для неуспішних або проміжних статусів
       * чек не створюємо.
       */
      if (
        String(data.transactionStatus) !==
        "Approved"
      ) {
        console.log(
          `Платіж ${data.orderReference}: ${data.transactionStatus}`
        );

        return res.json(
          createWayForPayAcceptResponse(
            data.orderReference
          )
        );
      }

      if (
        String(data.currency || "").toUpperCase() !==
        "UAH"
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
        "Помилка обробки callback:",
        message
      );

      /*
       * Не віддаємо accept, якщо чек не створено.
       * WayForPay повторить callback.
       */
      return res.status(502).json({
        status: "error",
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
    error: "Route not found"
  });
});

/*
|--------------------------------------------------------------------------
| Запуск
|--------------------------------------------------------------------------
*/

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Сервер запущено на порту ${PORT}`);

  console.log("Конфігурація сервера:", {
    merchantAccount: WAYFORPAY_MERCHANT_ACCOUNT,
    wayforpaySecretConfigured: Boolean(
      process.env.WAYFORPAY_SECRET_KEY
    ),
    vchasnoTokenConfigured: Boolean(
      process.env.VCHASNO_TOKEN
    ),
    vchasnoDevice: String(
      process.env.VCHASNO_DEVICE || "НЕ ЗАДАНО"
    ),
    paymentType: VCHASNO_PAYMENT_TYPE,
    taxGroup: VCHASNO_TAX_GROUP,
    vchasnoApiUrl: VCHASNO_API_URL
  });
});
