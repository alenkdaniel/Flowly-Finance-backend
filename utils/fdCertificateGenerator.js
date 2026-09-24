import PDFDocument from "pdfkit";

/**
 * "FD Certificate Generated" step of the approval flow.
 * Renders a one-page Fixed Deposit certificate as a PDF buffer, given the
 * just-activated FixedDeposit document and its owning User.
 *
 * @param {import("../models/FixedDeposit.js").default} fd
 * @param {import("../models/User.js").default} user
 * @param {{ accountNumber?: string }} [extra]
 * @returns {Promise<Buffer>}
 */
export const generateFDCertificate = (fd, user, extra = {}) => {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "A4", margin: 50 });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const formatINR = (n) =>
        `Rs. ${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const formatDate = (d) =>
        new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });
      const fdTypeLabel = { regular: "Regular", senior_citizen: "Senior Citizen", tax_saver: "Tax Saver" }[
        fd.fdType
      ] || fd.fdType;
      const payoutLabel =
        fd.interestPayoutOption === "cumulative"
          ? "Cumulative (paid at maturity)"
          : `${fd.interestPayoutOption[0].toUpperCase()}${fd.interestPayoutOption.slice(1)}`;

      // Border
      doc
        .rect(20, 20, doc.page.width - 40, doc.page.height - 40)
        .lineWidth(1.5)
        .strokeColor("#5B2E91")
        .stroke();

      // Header
      doc
        .fillColor("#5B2E91")
        .fontSize(22)
        .font("Helvetica-Bold")
        .text("Flowly Finance", 0, 55, { align: "center" });
      doc
        .fillColor("#333333")
        .fontSize(14)
        .font("Helvetica")
        .text("Fixed Deposit Certificate", { align: "center" });

      doc.moveDown(1.5);
      doc
        .moveTo(60, doc.y)
        .lineTo(doc.page.width - 60, doc.y)
        .strokeColor("#e0e0e0")
        .stroke();
      doc.moveDown(1);

      const row = (label, value) => {
        const y = doc.y;
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#555555").text(label, 70, y, { width: 200 });
        doc.font("Helvetica").fontSize(11).fillColor("#111111").text(String(value), 290, y, { width: 250 });
        doc.moveDown(0.9);
      };

      row("FD Certificate No.", fd.fdNumber);
      row("Customer Name", user?.name || "-");
      row("Registered Email", user?.email || "-");
      if (extra.accountNumber) row("Savings Account No.", extra.accountNumber);
      row("FD Type", fdTypeLabel);
      row("Principal Amount", formatINR(fd.principalAmount));
      row("Interest Rate", `${fd.interestRate}% p.a.`);
      row("Tenure", `${fd.tenureMonths} month(s)`);
      row("Interest Payout", payoutLabel);
      row("Start Date", formatDate(fd.startDate));
      row("Maturity Date", formatDate(fd.maturityDate));
      row("Maturity Amount", formatINR(fd.maturityAmount));
      row(
        "Maturity Instruction",
        { credit_to_savings: "Credit to Savings Account", renew_principal: "Renew Principal", renew_principal_and_interest: "Renew Principal + Interest" }[
          fd.maturityInstruction
        ] || fd.maturityInstruction
      );

      doc.moveDown(1);
      doc
        .moveTo(60, doc.y)
        .lineTo(doc.page.width - 60, doc.y)
        .strokeColor("#e0e0e0")
        .stroke();
      doc.moveDown(1.5);

      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor("#888888")
        .text(
          "This is a system-generated certificate issued on approval of the above Fixed Deposit and does not require a physical signature. " +
            "Please retain this certificate for your records.",
          70,
          doc.y,
          { width: doc.page.width - 140, align: "left" }
        );

      doc.moveDown(1);
      doc
        .fontSize(9)
        .fillColor("#aaaaaa")
        .text(`Issued on: ${formatDate(new Date())}`, 70, doc.y);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};

export default generateFDCertificate;