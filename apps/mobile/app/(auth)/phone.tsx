import { useState } from 'react';
import { Button, Text, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/state/auth';

export default function PhoneScreen() {
  const [phone, setPhone] = useState('+');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestOtp = useAuth((s) => s.requestOtp);
  const router = useRouter();

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await requestOtp(phone.trim());
      router.push({ pathname: '/(auth)/otp', params: { phone: phone.trim() } });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: '600' }}>Enter your phone number</Text>
      <Text>Use international format, e.g. +14155550123</Text>
      <TextInput
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        autoFocus
        style={{ borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 18 }}
      />
      {error && <Text style={{ color: 'crimson' }}>{error}</Text>}
      <Button title={busy ? 'Sending…' : 'Send code'} onPress={submit} disabled={busy} />
    </View>
  );
}
