import { useState } from 'react';
import { Button, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useAuth } from '../../src/state/auth';

export default function OtpScreen() {
  const { phone } = useLocalSearchParams<{ phone: string }>();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const verifyOtp = useAuth((s) => s.verifyOtp);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await verifyOtp(phone, code);
      // AuthGate redirects once status becomes signedIn.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1, justifyContent: 'center', padding: 24, gap: 12 }}>
      <Text style={{ fontSize: 24, fontWeight: '600' }}>Enter the 6-digit code</Text>
      <Text>Sent to {phone}</Text>
      <TextInput
        value={code}
        onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
        keyboardType="number-pad"
        autoFocus
        maxLength={6}
        style={{ borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 24, letterSpacing: 8 }}
      />
      {error && <Text style={{ color: 'crimson' }}>{error}</Text>}
      <Button title={busy ? 'Verifying…' : 'Verify'} onPress={submit} disabled={busy || code.length !== 6} />
    </View>
  );
}
