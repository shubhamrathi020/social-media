import { forwardRef } from 'react';
import {
  Text as RNText,
  TextInput as RNTextInput,
  type TextInputProps,
  type TextProps,
} from 'react-native';
import { useTheme } from '../theme';

/**
 * Drop-in replacements for React Native's Text and TextInput that follow light/dark mode.
 * A colour passed in `style` still wins, so explicit colours (e.g. on a blue chat bubble) keep working.
 */
export const Text = forwardRef<RNText, TextProps>(function Text({ style, ...rest }, ref) {
  const c = useTheme();
  return <RNText ref={ref} style={[{ color: c.text }, style]} {...rest} />;
});

export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput(
  { style, placeholderTextColor, ...rest },
  ref,
) {
  const c = useTheme();
  return (
    <RNTextInput
      ref={ref}
      placeholderTextColor={placeholderTextColor ?? c.muted}
      style={[{ color: c.text, borderColor: c.border }, style]}
      {...rest}
    />
  );
});
