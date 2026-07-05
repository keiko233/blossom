import { Resend } from "resend";

import { getServerEnv } from "./env";

const serverEnv = getServerEnv();

export const isEmailEnabled =
  Boolean(serverEnv.RESEND_API_KEY) && Boolean(serverEnv.RESEND_MAIL_FROM);

export const getEmailClient = () => {
  if (isEmailEnabled) {
    return new Resend(serverEnv.RESEND_API_KEY!);
  }

  return null;
};
