import { useState, useEffect } from 'react';

/**
 * Debounces a rapidly-changing value.
 *
 * How it works:
 * 1. Sets a timer every time `value` or `delayMs` changes.
 * 2. If `value` changes again before `delayMs` finishes, the cleanup function
 *    runs `clearTimeout`, cancelling the previous timer.
 * 3. Once typing settles for `delayMs`, the state is updated, triggering
 *    the downstream query effect.
 *
 * @param value The raw input value (e.g. search string)
 * @param delayMs The debounce interval in milliseconds (default: 300ms)
 * @returns The settled debounced value
 */
export function useDebounce<T>(value: T, delayMs = 300): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delayMs);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs]);

  return debouncedValue;
}
