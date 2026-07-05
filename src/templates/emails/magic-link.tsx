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

export default function MagicLinkEmail({
  email,
  link,
}: {
  email?: string;
  link?: string;
}) {
  return (
    <Html>
      <Head />

      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Preview>Welcome to {APP_NAME}</Preview>

        <Body className="bg-white font-sans">
          <Container className="mx-auto py-12">
            <Heading className="text-2xl font-semibold text-black">
              Welcome, {email}
            </Heading>

            <Text className="text-base text-zinc-700">
              Thanks for signing up for {APP_NAME}. Let's get you started.
            </Text>

            <Section className="mt-6">
              <Button
                className="rounded-md bg-black px-5 py-3 text-sm font-medium text-white"
                href={link}
              >
                Confirm your email
              </Button>
            </Section>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  );
}
