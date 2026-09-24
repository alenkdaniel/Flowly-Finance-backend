import LoanApplication from "../models/LoanApplication.js";
import TransactionBucket from "../models/TransactionBucket.js";
import Notification from "../models/Notification.js";
import Account from "../models/Account.js";
import { generateSchedule, round2 } from "../utils/emiCalculator.js";
import paymentGateway from "../services/paymentGateway.js";
import { creditAccountTopUpFromIntent } from "./depositController.js";

export async function generateScheduleOnDisbursal(loanId) {
  const loan = await LoanApplication.findById(loanId);
  if (!loan) throw new Error("Loan not found");
  if (loan.status !== "disbursed") {
    throw new Error("Schedule can only be generated for a disbursed loan");
  }

  const principal = loan.principal || loan.requestedAmount || 0;
  const { emi, totalInterest, totalRepayment, schedule } = generateSchedule({
    principal,
    annualRatePercent: loan.interestRate || 12,
    tenureMonths: loan.tenureMonths,
    startDate: loan.disbursedAt || new Date(),
  });

  loan.repayments = schedule.map((s) => ({
    ...s,
    status: s.status.toLowerCase(),
  }));
  loan.emiAmount = emi;
  loan.monthlyEMI = emi;
  loan.totalInterest = totalInterest;
  loan.totalRepayment = totalRepayment;
  loan.totalPayable = totalRepayment;
  loan.outstandingAmount = principal;
  loan.nextDueDate = schedule[0]?.dueDate || null;

  await loan.save();
  return loan;
}

export async function getSchedule(req, res) {
  try {
    const loanId = req.params.loanId || req.params.id;
    const loan = await LoanApplication.findById(loanId).select(
      "user principal requestedAmount interestRate tenureMonths emiAmount monthlyEMI totalInterest totalRepayment totalPayable outstandingAmount nextDueDate repayments status"
    );
    if (!loan) return res.status(404).json({ message: "Loan not found" });

    const userId = (req.user.id || req.user._id).toString();
    const isOwner = loan.user.toString() === userId;
    const isStaff = ["worker", "admin"].includes(req.user.role?.toLowerCase());
    if (!isOwner && !isStaff) return res.status(403).json({ message: "Not authorized" });

    return res.json({ loan });
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch schedule", error: err.message });
  }
}

export async function initiateRepayment(req, res) {
  try {
    const { loanId, installmentNo } = req.params;
    const loan = await LoanApplication.findById(loanId);
    if (!loan) return res.status(404).json({ message: "Loan not found" });

    const userId = (req.user.id || req.user._id).toString();
    if (loan.user.toString() !== userId) {
      return res.status(403).json({ message: "Not authorized" });
    }

    const installment = loan.repayments.find((r) => r.installmentNo === Number(installmentNo));
    if (!installment) return res.status(404).json({ message: "Installment not found" });
    if (installment.status === "paid") {
      return res.status(400).json({ message: "Installment already paid" });
    }

    const amountDue = round2(installment.emiAmount - (installment.paidAmount || 0));

    const intent = await paymentGateway.createPaymentIntent({
      amountInRupees: amountDue,
      metadata: {
        loanId: loan._id.toString(),
        installmentNo: String(installmentNo),
        userId,
      },
    });

    installment.gateway = {
      provider: "stripe",
      transactionId: intent.transactionId,
      status: "initiated",
    };
    await loan.save();

    return res.json({
      clientSecret: intent.clientSecret,
      transactionId: intent.transactionId,
      amountDue,
    });
  } catch (err) {
    return res.status(500).json({ message: "Failed to initiate payment", error: err.message });
  }
}

export async function handlePaymentWebhook(req, res) {
  let event;
  try {
    event = await paymentGateway.constructWebhookEvent(req.body, req.headers["stripe-signature"]);
  } catch (err) {
    return res.status(400).json({ message: `Webhook signature verification failed: ${err.message}` });
  }

  if (event.type && event.type !== "payment_intent.succeeded") {
    return res.status(200).json({ received: true });
  }

  const intent = event.data ? event.data.object : event;

  // Dispatch by purpose: account top-ups (FD "Add Money" step) vs. loan EMI
  // repayments share this one Stripe webhook endpoint.
  if (intent.metadata?.purpose === "account_topup") {
    try {
      await creditAccountTopUpFromIntent(intent);
      return res.status(200).json({ received: true });
    } catch (err) {
      return res.status(500).json({ message: err.message });
    }
  }

  const { loanId, installmentNo } = intent.metadata || {};
  if (!loanId || !installmentNo) {
    return res.status(400).json({ message: "Missing loan metadata on payment intent" });
  }

  try {
    await markInstallmentPaid({
      loanId,
      installmentNo: Number(installmentNo),
      amountPaid: (intent.amount_received || (intent.amount ? intent.amount : 0)) / 100,
      transactionId: intent.id || intent.transactionId,
      paymentMethod: intent.payment_method_types?.[0] || "card",
      provider: "stripe",
    });
    return res.status(200).json({ received: true });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
}

export async function markPaidManually(req, res) {
  try {
    const { loanId, installmentNo } = req.params;
    const { amountPaid, note } = req.body;

    const loan = await markInstallmentPaid({
      loanId,
      installmentNo: Number(installmentNo),
      amountPaid,
      transactionId: `manual-${Date.now()}`,
      paymentMethod: "offline",
      provider: "manual",
      note,
    });

    return res.json({ message: "Installment marked paid", loan });
  } catch (err) {
    return res.status(400).json({ message: err.message });
  }
}

async function markInstallmentPaid({
  loanId,
  installmentNo,
  amountPaid,
  transactionId,
  paymentMethod,
  provider,
  note,
}) {
  const loan = await LoanApplication.findById(loanId);
  if (!loan) throw new Error("Loan not found");

  const installment = loan.repayments.find((r) => r.installmentNo === installmentNo);
  if (!installment) throw new Error("Installment not found");
  if (installment.status === "paid") return loan;

  const totalPaid = round2((installment.paidAmount || 0) + amountPaid);
  installment.paidAmount = totalPaid;
  installment.paidDate = new Date();
  installment.status = totalPaid >= installment.emiAmount ? "paid" : "partially_paid";
  installment.gateway = {
    provider,
    transactionId,
    paymentMethod,
    status: "succeeded",
    rawResponse: note ? { note } : undefined,
  };

  loan.outstandingAmount = round2(
    loan.repayments
      .filter((r) => r.status !== "paid")
      .reduce((sum, r) => sum + (r.emiAmount - (r.paidAmount || 0)), 0)
  );
  const nextPending = loan.repayments.find((r) => ["pending", "partially_paid"].includes(r.status));
  loan.nextDueDate = nextPending ? nextPending.dueDate : null;
  loan.overdueInstallments = loan.repayments.filter((r) => r.status === "overdue").length;
  if (!nextPending) loan.status = "closed";

  await loan.save();

  if (loan.account) {
    await TransactionBucket.postEntry({
      accountId: loan.account,
      userId: loan.user,
      type: "emi",
      amount: amountPaid,
      description: `EMI installment #${installmentNo} for loan ${loan._id}`,
      refType: "LoanApplication",
      refId: loan._id,
      meta: { category: "emi" },
    });
  }

  await Notification.create({
    user: loan.user,
    type: "emi",
    title: "EMI Payment Received",
    message: `Your payment of ₹${amountPaid} for installment #${installmentNo} was successful.`,
    meta: { loanId: loan._id, installmentNo },
  });

  return loan;
}

export async function getRepaymentHistory(req, res) {
  try {
    const loanId = req.params.loanId || req.params.id;
    const loan = await LoanApplication.findById(loanId).select("user repayments");
    if (!loan) return res.status(404).json({ message: "Loan not found" });

    const userId = (req.user.id || req.user._id).toString();
    const isOwner = loan.user.toString() === userId;
    const isStaff = ["worker", "admin"].includes(req.user.role?.toLowerCase());
    if (!isOwner && !isStaff) return res.status(403).json({ message: "Not authorized" });

    const paidOnly = loan.repayments.filter((r) => ["paid", "partially_paid"].includes(r.status));
    return res.json({ repayments: paidOnly });
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch repayment history", error: err.message });
  }
}

export async function getOverdueLoans(req, res) {
  try {
    const loans = await LoanApplication.find({ overdueInstallments: { $gt: 0 } })
      .select("user principal requestedAmount emiAmount monthlyEMI nextDueDate overdueInstallments outstandingAmount")
      .populate("user", "name email");

    return res.json({ count: loans.length, loans });
  } catch (err) {
    return res.status(500).json({ message: "Failed to fetch overdue loans", error: err.message });
  }
}

export async function markOverdueInstallments() {
  const today = new Date();
  const loans = await LoanApplication.find({
    status: "disbursed",
    "repayments.status": { $in: ["pending", "partially_paid"] },
    "repayments.dueDate": { $lt: today },
  });

  for (const loan of loans) {
    let changed = false;
    for (const installment of loan.repayments) {
      if (
        installment.dueDate < today &&
        ["pending", "partially_paid"].includes(installment.status)
      ) {
        installment.status = "overdue";
        changed = true;

        await Notification.create({
          user: loan.user,
          type: "emi",
          title: "EMI Overdue",
          message: `Installment #${installment.installmentNo} of ₹${installment.emiAmount} is overdue.`,
          meta: { loanId: loan._id, installmentNo: installment.installmentNo },
        });
      }
    }

    if (changed) {
      loan.overdueInstallments = loan.repayments.filter((r) => r.status === "overdue").length;
      await loan.save();
    }
  }

  return { processed: loans.length };
}

export async function disburseLoan(req, res) {
  try {
    const loanId = req.params.loanId || req.params.id;
    const loan = await LoanApplication.findById(loanId);
    if (!loan) return res.status(404).json({ message: "Loan application not found" });

    if (loan.status !== "approved") {
      return res.status(400).json({
        message: `Loan cannot be disbursed because current status is '${loan.status}'. Only 'approved' loans can be disbursed.`,
      });
    }

    const account = await Account.findOne({ user: loan.user });
    if (!account) {
      return res.status(404).json({ message: "Customer bank account not found for disbursement" });
    }

    const amount = loan.requestedAmount || loan.principal || 0;
    account.balance += amount;
    await account.save();

    await TransactionBucket.postEntry({
      accountId: account._id,
      userId: loan.user,
      type: "credit",
      amount,
      description: `Loan Disbursement: ${loan.productName || "Personal Loan"} (App ID: ${loan._id})`,
      refType: "LoanApplication",
      refId: loan._id,
      meta: { category: "disbursement", balanceAfter: account.balance },
    });

    loan.status = "disbursed";
    loan.disbursedAt = new Date();
    loan.account = account._id;
    await loan.save();

    const updatedLoan = await generateScheduleOnDisbursal(loan._id);

    await Notification.create({
      user: loan.user,
      type: "loan",
      title: "Loan Disbursed",
      message: `Your loan of ₹${amount} has been disbursed to your account. First EMI due ${updatedLoan.nextDueDate ? updatedLoan.nextDueDate.toDateString() : 'soon'}.`,
      meta: { loanId: loan._id },
    }).catch((err) => console.error("Notification failed:", err));

    return res.json({
      message: `Loan of ₹${amount} successfully disbursed to customer account and EMI schedule generated`,
      loan: updatedLoan,
      accountBalance: account.balance,
    });
  } catch (err) {
    return res.status(500).json({ message: "Failed to disburse loan", error: err.message });
  }
}