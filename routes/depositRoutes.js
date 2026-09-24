import express from "express";
import {
  depositFunds,
  initiateAccountTopUp,
  confirmAccountTopUp,
  calculateFixedDeposit,
  createFixedDeposit,
  getUserDeposits,
  getFixedDepositById,
  closeFixedDepositEarly,
  triggerFDMaturityCheck,
  getFDWorkerQueue,
  getFDReviewDetails,
  approveFixedDeposit,
  rejectFixedDeposit,
  requestFDMoreInformation,
  submitFDAdditionalInfo,
} from "../controllers/depositController.js";
import {
  listActiveSchemes,
  listAllSchemes,
  getSchemeById,
  createScheme,
  updateScheme,
  toggleSchemeActive,
} from "../controllers/fdSchemeController.js";
import { protect, authorize } from "../middleware/authMiddleware.js";
import { uploadFDSupportingDoc } from "../middleware/uploadMiddleware.js";

const router = express.Router();

// Customer deposit endpoints
router.post("/account/deposit", protect, depositFunds);
// "Add Money" step — Stripe top-up when the FD Balance Check comes up short
router.post("/account/topup/initiate", protect, authorize("customer"), initiateAccountTopUp);
router.post("/account/topup/confirm", protect, authorize("customer"), confirmAccountTopUp);

// FD Scheme catalog — "customer gets different FD schemes" (like a real bank
// app's FD product list) + "worker can edit FD features" (the catalog itself).
// All registered ahead of the "/fd/:id" catch-all below, same reasoning as
// the "/fd/queue" note further down: Express matches in declaration order,
// so a literal path like "/fd/schemes" must come before "/fd/:id" or it
// would be swallowed as :id = "schemes".
router.get("/fd/schemes", protect, authorize("customer"), listActiveSchemes);
router.get("/fd/schemes/all", protect, authorize("worker", "admin"), listAllSchemes);
router.get("/fd/schemes/:id", protect, authorize("worker", "admin"), getSchemeById);
router.post("/fd/schemes", protect, authorize("worker", "admin"), createScheme);
router.put("/fd/schemes/:id", protect, authorize("worker", "admin"), updateScheme);
router.patch("/fd/schemes/:id/toggle", protect, authorize("worker", "admin"), toggleSchemeActive);

// "Enter FD Details" -> "System Calculates" preview (no money moves, nothing is created)
router.post("/fd/calculate", protect, authorize("customer"), calculateFixedDeposit);
router.post("/fd/create", protect, authorize("customer"), createFixedDeposit);
router.get("/my-deposits", protect, authorize("customer"), getUserDeposits);
// NOTE: worker's "/fd/queue" is registered further below but MUST resolve before this
// catch-all "/fd/:id" — Express matches routes in declaration order, so it's placed
// ahead of this line, not after it.
router.get("/fd/queue", protect, authorize("worker", "admin"), getFDWorkerQueue);
router.get("/fd/:id", protect, authorize("customer"), getFixedDepositById);
router.post("/fd/:id/close", protect, authorize("customer"), closeFixedDepositEarly);
// "Customer Uploads Information" — respond to a worker's info request; sends the FD back for re-review
router.post("/fd/:id/submit-info", protect, authorize("customer"), uploadFDSupportingDoc, submitFDAdditionalInfo);

// Worker/admin: manually run the maturity sweep on demand (also runs daily via cron)
router.post("/fd/process-maturity", protect, authorize("worker", "admin"), triggerFDMaturityCheck);

// Worker/admin: FD review & decision flow (Worker Review -> Decision). The queue
// endpoint itself is registered above, ahead of the customer's "/fd/:id" route.
router.get("/fd/:id/review", protect, authorize("worker", "admin"), getFDReviewDetails);
router.post("/fd/:id/approve", protect, authorize("worker", "admin"), approveFixedDeposit);
router.post("/fd/:id/reject", protect, authorize("worker", "admin"), rejectFixedDeposit);
router.post("/fd/:id/request-info", protect, authorize("worker", "admin"), requestFDMoreInformation);

export default router;