"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type LoadStatus = "idle" | "loading" | "success" | "error";

type LoadableState<T> = {
  data: T | null;
  status: LoadStatus;
  error: string | null;
};

export function useApiResource<T>(loader: () => Promise<T>) {
  const [state, setState] = useState<LoadableState<T>>({
    data: null,
    status: "idle",
    error: null
  });

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(async () => {
    setState((current) => ({
      data: current.data,
      status: "loading",
      error: null
    }));

    try {
      const data = await loaderRef.current();
      setState({
        data,
        status: "success",
        error: null
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown request error";
      setState((current) => ({
        data: current.data,
        status: "error",
        error: message
      }));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    ...state,
    reload
  };
}
