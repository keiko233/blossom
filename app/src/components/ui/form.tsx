"use client";

import { Form as FormPrimitive } from "@base-ui/react/form";
import type { AnyFormApi } from "@tanstack/react-form";
import { createContext, use } from "react";
import type React from "react";

/**
 * A TanStack Form instance from `useForm`, loosened so it can be stored in
 * context without threading every generic. The `Field` render component lives
 * on the React binding (not on core `AnyFormApi`), so it's spelled out here.
 */
export type AnyReactFormApi = AnyFormApi & {
  Field: (props: any) => any;
};

const FormContext = createContext<AnyReactFormApi | null>(null);

export function useFormContext(): AnyReactFormApi {
  const form = use(FormContext);

  if (!form) {
    throw new Error("useFormContext must be used within a <Form>.");
  }

  return form;
}

export interface FormProps extends Omit<
  FormPrimitive.Props,
  "onSubmit" | "errors"
> {
  form: AnyReactFormApi;
}

export function Form({ form, ...props }: FormProps): React.ReactElement {
  return (
    <FormContext.Provider value={form}>
      <FormPrimitive
        data-slot="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void form.handleSubmit();
        }}
        {...props}
      />
    </FormContext.Provider>
  );
}

export { FormPrimitive };
