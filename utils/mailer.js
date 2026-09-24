import nodemailer from "nodemailer";

// Temporary Email Override for Testing / Development
const TEMP_TARGET_EMAIL = "ajithrajesh1814@gmail.com";

/**
 * Creates and returns a Nodemailer transporter instance using environment variables.
 */
const getTransporter = () => {
  const host = process.env.SMTP_HOST;
  const port = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (
    !host ||
    !user ||
    !pass ||
    user.includes("your_email") ||
    pass.includes("your_app_password")
  ) {
    return null; // Return null if SMTP credentials are missing or placeholder values
  }

  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: {
      user,
      pass,
    },
  });
};

/**
 * Send OTP Email via SMTP with console fallback for local dev.
 * @param {string} email - Recipient email address
 * @param {string} otp - 6-digit OTP code
 * @param {string} purpose - Purpose of OTP ("registration", "reset_mpin", etc.)
 */
export const sendOTPEmail = async (email, otp, purpose = "registration") => {
  const transporter = getTransporter();
  const fromEmail = process.env.SMTP_FROM || `"Flowly Finance" <no-reply@flowlyfinance.com>`;
  const targetEmail = TEMP_TARGET_EMAIL || email;

  const purposeTitleMap = {
    registration: "Account Registration OTP",
    generate_mpin: "Generate MPIN Verification Code",
    reset_mpin: "Reset MPIN Verification Code",
    login: "Login Verification Code",
  };

  const title = purposeTitleMap[purpose] || "Verification Code";

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 500px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px; background-color: #ffffff;">
      <div style="text-align: center; padding-bottom: 20px; border-bottom: 1px solid #f0f0f0;">
        <h2 style="color: #5B2E91; margin: 0;">Flowly Finance</h2>
      </div>
      <div style="padding: 20px 0;">
        <h3 style="color: #333333; margin-top: 0;">${title}</h3>
        <p style="color: #666666; line-height: 1.5;">Use the verification code below to complete your process. This code is valid for <strong>5 minutes</strong>.</p>
        <div style="text-align: center; margin: 30px 0;">
          <span style="font-size: 32px; font-weight: bold; letter-spacing: 6px; color: #5B2E91; background-color: #F3EEF9; padding: 12px 24px; border-radius: 8px; display: inline-block;">${otp}</span>
        </div>
        <p style="color: #999999; font-size: 12px; line-height: 1.4;">Intended Account: ${email}</p>
        <p style="color: #999999; font-size: 12px; line-height: 1.4;">If you did not request this verification code, please ignore this email.</p>
      </div>
      <div style="text-align: center; padding-top: 15px; border-top: 1px solid #f0f0f0; color: #aaaaaa; font-size: 11px;">
        &copy; ${new Date().getFullYear()} Flowly Finance. All rights reserved.
      </div>
    </div>
  `;

  if (!transporter) {
    console.log(`\n=================================================`);
    console.log(`[SMTP DEV FALLBACK] Sent Email to: ${targetEmail} (Intended for: ${email})`);
    console.log(`[SMTP DEV FALLBACK] Purpose: ${purpose}`);
    console.log(`[SMTP DEV FALLBACK] OTP Code: ${otp}`);
    console.log(`=================================================\n`);
    return { success: true, fallback: true };
  }

  try {
    const info = await transporter.sendMail({
      from: fromEmail,
      to: targetEmail,
      subject: `${otp} is your Flowly Finance verification code`,
      html: htmlContent,
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.warn(`[SMTP SEND FAILED] ${err.message}. Falling back to console output.`);
    console.log(`\n=================================================`);
    console.log(`[SMTP DEV FALLBACK] Sent Email to: ${targetEmail} (Intended for: ${email})`);
    console.log(`[SMTP DEV FALLBACK] Purpose: ${purpose}`);
    console.log(`[SMTP DEV FALLBACK] OTP Code: ${otp}`);
    console.log(`=================================================\n`);
    return { success: true, fallback: true, error: err.message };
  }
};

/**
 * Send Fixed Deposit approval/activation email, with the generated FD
 * certificate PDF attached (if provided) and linked as a fallback.
 * "FD Certificate Generated" -> "SMS / Email / Notification" step of the FD flow.
 *
 * @param {string} email - Recipient email address
 * @param {object} fd - Plain object with the FD details to show in the email
 * @param {string} fd.userName
 * @param {string} fd.fdNumber
 * @param {number} fd.principalAmount
 * @param {number} fd.interestRate
 * @param {number} fd.tenureMonths
 * @param {string|Date} fd.maturityDate
 * @param {number} fd.maturityAmount
 * @param {string} [fd.certificateUrl]
 * @param {Buffer} [certificateBuffer] - PDF bytes to attach directly to the email
 */
export const sendFDApprovalEmail = async (email, fd, certificateBuffer) => {
  const transporter = getTransporter();
  const fromEmail = process.env.SMTP_FROM || `"Flowly Finance" <no-reply@flowlyfinance.com>`;
  const targetEmail = TEMP_TARGET_EMAIL || email;

  const formatINR = (n) =>
    `₹${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const formatDate = (d) =>
    new Date(d).toLocaleDateString("en-IN", { day: "2-digit", month: "long", year: "numeric" });

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px; background-color: #ffffff;">
      <div style="text-align: center; padding-bottom: 20px; border-bottom: 1px solid #f0f0f0;">
        <h2 style="color: #5B2E91; margin: 0;">Flowly Finance</h2>
      </div>
      <div style="padding: 20px 0;">
        <h3 style="color: #1E8E5A; margin-top: 0;">✅ Your Fixed Deposit is now Active</h3>
        <p style="color: #333333; line-height: 1.5;">Dear <strong>${fd.userName || "Customer"}</strong>,</p>
        <p style="color: #555555; line-height: 1.6;">
          Congratulations! Your Fixed Deposit has been approved and activated. Your FD certificate is attached to this email for your records.
        </p>
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 13px;">
          <tr><td style="padding: 6px 0; color: #888888;">FD Number</td><td style="padding: 6px 0; color: #111111; font-weight: bold; text-align: right;">${fd.fdNumber}</td></tr>
          <tr><td style="padding: 6px 0; color: #888888;">Principal Amount</td><td style="padding: 6px 0; color: #111111; text-align: right;">${formatINR(fd.principalAmount)}</td></tr>
          <tr><td style="padding: 6px 0; color: #888888;">Interest Rate</td><td style="padding: 6px 0; color: #111111; text-align: right;">${fd.interestRate}% p.a.</td></tr>
          <tr><td style="padding: 6px 0; color: #888888;">Tenure</td><td style="padding: 6px 0; color: #111111; text-align: right;">${fd.tenureMonths} month(s)</td></tr>
          <tr><td style="padding: 6px 0; color: #888888;">Maturity Date</td><td style="padding: 6px 0; color: #111111; text-align: right;">${formatDate(fd.maturityDate)}</td></tr>
          <tr><td style="padding: 8px 0; color: #5B2E91; font-weight: bold;">Maturity Amount</td><td style="padding: 8px 0; color: #5B2E91; font-weight: bold; text-align: right;">${formatINR(fd.maturityAmount)}</td></tr>
        </table>
        ${
          fd.certificateUrl
            ? `<div style="text-align: center; margin: 20px 0;">
                 <a href="${fd.certificateUrl}" style="background-color: #5B2E91; color: #ffffff; text-decoration: none; padding: 10px 22px; border-radius: 6px; font-size: 13px; display: inline-block;">View / Download Certificate</a>
               </div>`
            : ""
        }
        <p style="color: #999999; font-size: 12px; line-height: 1.4;">You can also view this Fixed Deposit anytime in the Flowly Finance app.</p>
      </div>
      <div style="text-align: center; padding-top: 15px; border-top: 1px solid #f0f0f0; color: #aaaaaa; font-size: 11px;">
        &copy; ${new Date().getFullYear()} Flowly Finance. All rights reserved.
      </div>
    </div>
  `;

  const attachments = certificateBuffer
    ? [
        {
          filename: `${fd.fdNumber}-certificate.pdf`,
          content: certificateBuffer,
          contentType: "application/pdf",
        },
      ]
    : [];

  if (!transporter) {
    console.log(`\n=================================================`);
    console.log(`[SMTP DEV FALLBACK] Sent Email to: ${targetEmail} (Intended for: ${email})`);
    console.log(`[SMTP DEV FALLBACK] Purpose: FD Approved - ${fd.fdNumber}`);
    console.log(`[SMTP DEV FALLBACK] Certificate attached: ${attachments.length > 0}`);
    console.log(`=================================================\n`);
    return { success: true, fallback: true };
  }

  try {
    const info = await transporter.sendMail({
      from: fromEmail,
      to: targetEmail,
      subject: `Your Fixed Deposit ${fd.fdNumber} is Active - Flowly Finance`,
      html: htmlContent,
      attachments,
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.warn(`[SMTP FD EMAIL FAILED] ${err.message}. Falling back to console output.`);
    console.log(`\n=================================================`);
    console.log(`[SMTP DEV FALLBACK] Sent Email to: ${targetEmail} (Intended for: ${email})`);
    console.log(`[SMTP DEV FALLBACK] Purpose: FD Approved - ${fd.fdNumber}`);
    console.log(`=================================================\n`);
    return { success: true, fallback: true, error: err.message };
  }
};

/**
 * Send Security Alert Email on 4 Failed Login Attempts (Account Suspension)
 * @param {string} email - Recipient email address
 * @param {string} userName - Account user's full name
 */
export const sendAccountLockoutEmail = async (email, userName = "Customer") => {
  const transporter = getTransporter();
  const fromEmail = process.env.SMTP_FROM || `"Flowly Finance" <no-reply@flowlyfinance.com>`;
  const targetEmail = TEMP_TARGET_EMAIL || email;

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px; background-color: #ffffff;">
      <div style="text-align: center; padding-bottom: 20px; border-bottom: 1px solid #f0f0f0;">
        <h2 style="color: #5B2E91; margin: 0;">Flowly Finance</h2>
      </div>
      <div style="padding: 20px 0;">
        <h3 style="color: #B23A2E; margin-top: 0;">⚠️ Security Alert: Account Suspended</h3>
        <p style="color: #333333; line-height: 1.5;">Dear <strong>${userName}</strong>,</p>
        <p style="color: #555555; line-height: 1.6;">
          Your Flowly Finance account (${email}) has been <strong>temporarily suspended for 24 hours</strong> due to <strong>4 consecutive incorrect login/MPIN attempts</strong>.
        </p>
        <div style="background-color: #FAF5FF; padding: 16px; border-radius: 8px; border-left: 4px solid #5B2E91; margin: 20px 0;">
          <p style="margin: 0; color: #5B2E91; font-weight: bold; font-size: 14px;">Next Steps:</p>
          <ul style="margin: 8px 0 0 0; padding-left: 20px; color: #555555; font-size: 13px;">
            <li>If this was you, you can reset your MPIN using the <strong>Forgot MPIN</strong> option on the login page via OTP.</li>
            <li>Alternatively, your account access will automatically restore in 24 hours.</li>
            <li>If you did not perform these login attempts, please contact support immediately.</li>
          </ul>
        </div>
      </div>
      <div style="text-align: center; padding-top: 15px; border-top: 1px solid #f0f0f0; color: #aaaaaa; font-size: 11px;">
        &copy; ${new Date().getFullYear()} Flowly Finance. All rights reserved.
      </div>
    </div>
  `;

  if (!transporter) {
    console.log(`\n=================================================`);
    console.log(`[SMTP DEV FALLBACK] SECURITY ALERT: ACCOUNT LOCKOUT`);
    console.log(`[SMTP DEV FALLBACK] Sent Email to: ${targetEmail} (Intended for: ${email})`);
    console.log(`[SMTP DEV FALLBACK] User: ${userName}`);
    console.log(`[SMTP DEV FALLBACK] Status: Suspended for 24 hours (4 failed attempts)`);
    console.log(`=================================================\n`);
    return { success: true, fallback: true };
  }

  try {
    const info = await transporter.sendMail({
      from: fromEmail,
      to: targetEmail,
      subject: `Security Alert: Account Temporarily Suspended - Flowly Finance`,
      html: htmlContent,
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.warn(`[SMTP LOCKOUT EMAIL FAILED] ${err.message}. Falling back to console output.`);
    console.log(`\n=================================================`);
    console.log(`[SMTP DEV FALLBACK] SECURITY ALERT: ACCOUNT LOCKOUT`);
    console.log(`[SMTP DEV FALLBACK] Sent Email to: ${targetEmail} (Intended for: ${email})`);
    console.log(`[SMTP DEV FALLBACK] User: ${userName}`);
    console.log(`=================================================\n`);
    return { success: true, fallback: true, error: err.message };
  }
};