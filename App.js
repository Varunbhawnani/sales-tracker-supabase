import React, { useEffect, useState, useRef } from 'react';
import { StatusBar, View, StyleSheet } from 'react-native';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import {
  useFonts,
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import * as SplashScreen from 'expo-splash-screen';
import NetInfo from '@react-native-community/netinfo';
import Toast from 'react-native-toast-message';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider, useAuth } from './src/contexts/AuthContext';
import AppNavigator from './src/navigation/AppNavigator';
import LoginScreen from './src/screens/LoginScreen';
import LoadingState from './src/components/LoadingState';
import OfflineBanner from './src/components/OfflineBanner';
import {
  registerForPushNotifications,
  savePushToken,
  setupNotificationResponseListener,
  setupTokenRefreshListener,
} from './src/services/notificationService';
import { COLORS } from './src/utils/constants';

// Prevent splash from auto-hiding
SplashScreen.preventAutoHideAsync();

function AppContent() {
  const { isAuthenticated, loading, userId } = useAuth();
  const [isOffline, setIsOffline] = useState(false);
  const navigationRef = useNavigationContainerRef();
  const notifResponseSub = useRef(null);
  const tokenRefreshSub = useRef(null);

  // Network status
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      setIsOffline(!state.isConnected);
    });
    return () => unsubscribe();
  }, []);

  // Push notifications setup
  useEffect(() => {
    if (isAuthenticated && userId) {
      (async () => {
        const token = await registerForPushNotifications();
        if (token) {
          await savePushToken(userId, token);
        }
      })();

      // Token refresh listener
      tokenRefreshSub.current = setupTokenRefreshListener(userId);
    }

    return () => {
      if (tokenRefreshSub.current) {
        tokenRefreshSub.current.remove();
      }
    };
  }, [isAuthenticated, userId]);

  // Notification deep linking
  useEffect(() => {
    if (navigationRef.current) {
      notifResponseSub.current = setupNotificationResponseListener(navigationRef.current);
    }
    return () => {
      if (notifResponseSub.current) {
        notifResponseSub.current.remove();
      }
    };
  }, [navigationRef]);

  if (loading) return <LoadingState />;

  return (
    <View style={styles.container}>
      <StatusBar barStyle="dark-content" backgroundColor={COLORS.background} />
      <OfflineBanner visible={isOffline} />

      {isAuthenticated ? (
        <NavigationContainer ref={navigationRef}>
          <AppNavigator />
        </NavigationContainer>
      ) : (
        <LoginScreen />
      )}

      <Toast />
    </View>
  );
}

export default function App() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  if (!fontsLoaded) return null;

  return (
    <SafeAreaProvider>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
});
