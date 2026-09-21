import express from "express";
import dotenv from "dotenv";
import cors from "cors";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import connectDB from "./config/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import authRoutes from "./routes/authRoutes.js";
import kycRoutes from "./routes/kycRoutes.js";
import videoKycRoutes from "./routes/videoKycRoutes.js";
import { initVideoKycSocket } from "./sockets/videoKycSocket.js";
import calculatorRoutes from "./routes/calculatorRoutes.js";
import depositRoutes from "./routes/depositRoutes.js";
import loanRoutes from "./routes/loanRoutes.js";
import customerDashboardRoutes from "./routes/customerDashboardRoutes.js";
import customerRoutes from "./routes/customerRoutes.js";
import notificationRoutes from "./routes/notificationRoutes.js";
import repaymentRoutes from "./routes/repaymentRoutes.js";
import webhookRoutes from "./routes/webhookRoutes.js";
import { startOverdueCheckJob } from "./jobs/overdueCheckJob.js";

dotenv.config();

connectDB();

const app = express();

app.use(cors());

// Webhook route requires raw body before express.json()
app.use("/api/webhooks", webhookRoutes);

app.use(express.json());

// Serve uploaded KYC documents (images/PDFs) as static files
app.use("/uploads", express.static(path.join(__dirname, "uploads")));


// Health Check
app.get("/", (req, res) => {
  res.json({
    message: "Flowly Finance Backend API is running 🚀",
    version: "1.0.0",
    modules: [
      "User & Worker Authentication",
      "KYC Verification Workflow & Review Queue",
      "Loan EMI & FD Calculators",
      "Savings & Fixed Deposit Management",
      "Loan Products, Applications, Worker Approvals & Disbursement",
      "Customer Dashboard & Financial Metrics",
      "Video KYC (WebRTC scheduling, calls & recording)",
      "User Notifications System",
      "EMI Repayments & Payment Gateway Integration",
    ],
  });
});

// API Routes
app.use("/api/auth", authRoutes);
app.use("/api/kyc", kycRoutes);
app.use("/api/video-kyc", videoKycRoutes);
app.use("/api/calculator", calculatorRoutes);
app.use("/api/deposits", depositRoutes);
app.use("/api/loans", loanRoutes);
app.use("/api/customer/dashboard", customerDashboardRoutes);
app.use("/api/customers", customerRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/repayments", repaymentRoutes);

// Start background cron / timer jobs
startOverdueCheckJob();

// Global 404 Handler
app.use((req, res) => {
  res.status(404).json({
    message: `Route '${req.originalUrl}' not found.`,
  });
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error("Unhandled Server Error:", err);
  res.status(500).json({
    message: "Internal server error",
    error: err.message,
  });
});

const PORT = process.env.PORT || 5000;

// HTTP server shared by Express and the Video KYC (Socket.IO) signaling
const server = http.createServer(app);
initVideoKycSocket(server);

server.listen(PORT, () => {
  console.log(`Server running on port http://localhost:${PORT}`);
});

export default app;