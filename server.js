const express = require("express");
require("dotenv").config();

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.json({
    message: "SMC Trading Coach AI is running",
    version: "1.0.0"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`SMC Trading Coach AI running on port ${PORT}`);
});
