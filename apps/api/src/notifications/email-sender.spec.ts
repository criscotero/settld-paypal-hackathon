import { loadSmtpConfig } from "./email-sender.js";

const SET = { SMTP_HOST: "smtp.gmail.com", SMTP_USER: "me@example.test", SMTP_PASSWORD: "secret" };

describe("loadSmtpConfig", () => {
  it("without a complete server, there is no mail and nothing breaks", () => {
    expect(loadSmtpConfig({})).toBeNull();
    expect(loadSmtpConfig({ ...SET, SMTP_HOST: "" })).toBeNull();
    expect(loadSmtpConfig({ ...SET, SMTP_PASSWORD: undefined })).toBeNull();
  });
  it("defaults to port 587 and to sending as the account", () => {
    expect(loadSmtpConfig(SET)).toEqual({ host: "smtp.gmail.com", port: 587, user: "me@example.test", password: "secret", from: "me@example.test" });
  });
  it("uses EMAIL_FROM when it is set", () => {
    expect(loadSmtpConfig({ ...SET, EMAIL_FROM: "Settld <no-reply@settld.test>" })?.from).toBe("Settld <no-reply@settld.test>");
  });
  it("an empty port means the default, not port 0", () => {
    expect(loadSmtpConfig({ ...SET, SMTP_PORT: "" })?.port).toBe(587);
  });
  it("refuses a port that is not a port", () => {
    expect(() => loadSmtpConfig({ ...SET, SMTP_PORT: "abc" })).toThrow("SMTP_PORT");
    expect(() => loadSmtpConfig({ ...SET, SMTP_PORT: "70000" })).toThrow("SMTP_PORT");
  });
});
