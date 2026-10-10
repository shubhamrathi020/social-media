import { useState } from 'react';
import { Button, View } from 'react-native';
import { Text, TextInput } from '../../src/components/themed';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/state/auth';
import { useT } from '../../src/i18n';

export default function PhoneScreen() {
  const t = useT();
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
      <Text style={{ fontSize: 24, fontWeight: '600' }}>{t('Enter your phone number')}</Text>
      <Text>{t('Use international format, e.g. +14155550123')}</Text>
      <TextInput
        value={phone}
        onChangeText={setPhone}
        keyboardType="phone-pad"
        autoFocus
        style={{ borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 18 }}
      />
      {error && <Text style={{ color: 'crimson' }}>{error}</Text>}
      <Button title={busy ? t('Sending…') : t('Send code')} onPress={submit} disabled={busy} />
    </View>
  );
}
