import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Section,
  pixelBasedPreset,
  Tailwind,
  Text,
} from "react-email";

import { getServerEnv } from "@/lib/env";

const { APP_NAME } = getServerEnv();

export default function PasswordResetEmail({ link }: { link?: string }) {
  return (
    <Html>
      <Head />

      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Preview>Reset your {APP_NAME} password</Preview>

        <Body className="bg-white font-sans">
          <Container className="mx-auto py-12">
            <Heading className="text-2xl font-semibold text-black">
              Reset your password
            </Heading>

            <Text className="text-base text-zinc-700">
              We received a request to set a new password for your {APP_NAME}{" "}
              account. The link below works once and expires in 30 minutes.
            </Text>

            <Section className="mt-6">
              <Button
                className="rounded-md bg-black px-5 py-3 text-sm font-medium text-white"
                href={link}
              >
                Choose a new password
              </Button>
            </Section>

            <Text className="text-sm text-zinc-500">
              If you did not ask for this, you can ignore this email: your
              password stays unchanged.
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
