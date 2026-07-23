import express from "express";

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (_req, res) => {
  res.json({
    status: "ok",
    service: "WayForPay → Вчасно.Каса"
  });
});

app.post("/webhooks/wayforpay", (req, res) => {
  console.log("WayForPay callback:", req.body);

  res.json({
    status: "received"
  });
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, "0.0.0.0", () => {
  console.log(`Server started on port ${port}`);
});
