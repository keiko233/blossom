import z from "zod";

export const emailSignInSchema = z.object({
  email: z.email(),
  password: z.string().min(8),
  callbackURL: z.string().url().optional(),
  rememberMe: z.boolean().optional(),
});

export const emailSignUpSchema = z.object({
  email: z.email(),
});
