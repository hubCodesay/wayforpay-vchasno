import crypto from "node:crypto";
import express from "express";

const app = express();

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));

function createSignature(value) {
  return crypto
    .createHmac("md5", process.env.WAYFORPAY_SECRET_KEY)
    .update(value, "utf8")
    .digest("hex");
}

function signaturesMatch(received, expected) {
  const first = Buffer.from(String(received || "").toLowerCase(), "utf8");
  const second = Buffer.from(String(expected).toLowerCase(), "utf8");

  return (
    first.length === second.length &&
    crypto.timingSafeEqual(first, second)
  );
}

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "WayForPay → Вчасно.Каса"
  });
});

app.post("/webhooks/wayforpay", (req, res) => {
  const data = req.body;

  const merchantAccount = process.env.WAYFORPAY_MERCHANT_ACCOUNT;
  const secretKey = process.env.WAYFORPAY_SECRET_KEY;

  if (!merchantAccount || !secretKey) {
    return res.status(500).json({
      error: "WayForPay variables are not configured"
    });
  }

  if (data.merchantAccount !== merchantAccount) {
    return res.status(401).json({
      error: "Invalid merchant account"
    });
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

  const expectedSignature = createSignature(signatureString);

  if (!signaturesMatch(data.merchantSignature, expectedSignature)) {
    console.error("Invalid WayForPay signature");

    return res.status(401).json({
      error: "Invalid signature"
    });
  }

  if (data.transactionStatus === "Approved") {
    console.log("Successful payment:", {
      orderReference: data.orderReference,
      amount: data.amount,
      currency: data.currency,
      email: data.email,
      phone: data.phone
    });

    // Тут пізніше буде створення чека.
  }

  const time = Math.floor(Date.now() / 1000);
  const status = "accept";

  const responseSignature = createSignature(
    [data.orderReference, status, time].join(";")
  );

  return res.json({
    orderReference: data.orderReference,
    status,
    time,
    signature: responseSignature
  });
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, "0.0.0.0", () => {
  console.log(`Server running on port ${port}`);
});
