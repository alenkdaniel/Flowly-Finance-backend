import express from "express";
import {
  submitKYC,
  getKYCStatus,
  getKycQueue,
  getKycDetail,
  startKycReview,
  approveKyc,
  rejectKyc,
  retryKycOcr,
} from "../controllers/kycController.js";
import { protect, authorize } from "../middleware/authMiddleware.js";
import { uploadKycFiles } from "../middleware/uploadMiddleware.js";

const router = express.Router();

// Customer KYC routes
// multipart/form-data fields: pan, aadhaar, selfie (optional), document (legacy)
router.post(
  "/submit",
  protect,
  authorize("customer"),
  uploadKycFiles,
  submitKYC
);
router.get("/status", protect, authorize("customer"), getKYCStatus);

// Worker / Admin KYC review queue routes
router.get("/queue", protect, authorize("worker", "admin"), getKycQueue);
router.get("/:id", protect, authorize("worker", "admin"), getKycDetail);
router.put("/:id/start-review", protect, authorize("worker", "admin"), startKycReview);
router.put("/:id/approve", protect, authorize("worker", "admin"), approveKyc);
router.put("/:id/reject", protect, authorize("worker", "admin"), rejectKyc);
router.post("/:id/ocr/retry", protect, authorize("worker", "admin"), retryKycOcr);

export default router;