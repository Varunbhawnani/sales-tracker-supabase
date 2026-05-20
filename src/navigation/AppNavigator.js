import React, { useState } from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Text, View, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { COLORS, ROLES, SAFE_TOP } from '../utils/constants';
import { useAuth } from '../contexts/AuthContext';

// Screens
import FeedScreen from '../screens/FeedScreen';
import NewQueryScreen from '../screens/NewQueryScreen';
import QueryDetailScreen from '../screens/QueryDetailScreen';
import LeaderboardScreen from '../screens/LeaderboardScreen';
import MyStatsScreen from '../screens/MyStatsScreen';
import OwnerDashboardScreen from '../screens/OwnerDashboardScreen';
import AdminScreen from '../screens/AdminScreen';
import AccountsDashboardScreen from '../screens/AccountsDashboardScreen';
import DispatchDashboardScreen from '../screens/DispatchDashboardScreen';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();
const IS_WEB = Platform.OS === 'web';

// ─── Stack Navigators (per tab) ─────────────────────────────────────────────
function FeedStack() {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="FeedMain" component={FeedScreen} />
      <Stack.Screen name="NewQuery" component={NewQueryScreen} options={{ headerShown: true, headerTitle: 'New Query', headerTintColor: COLORS.primary, headerStyle: { backgroundColor: COLORS.surface } }} />
      <Stack.Screen name="QueryDetail" component={QueryDetailScreen} options={{ headerShown: true, headerTitle: 'Query Details', headerTintColor: COLORS.primary, headerStyle: { backgroundColor: COLORS.surface } }} />
    </Stack.Navigator>
  );
}
function LeaderboardStack() { return <Stack.Navigator screenOptions={{ headerShown: false }}><Stack.Screen name="LeaderboardMain" component={LeaderboardScreen} /></Stack.Navigator>; }
function MyStatsStack()    { return <Stack.Navigator screenOptions={{ headerShown: false }}><Stack.Screen name="MyStatsMain" component={MyStatsScreen} /></Stack.Navigator>; }
function DashboardStack()  { return <Stack.Navigator screenOptions={{ headerShown: false }}><Stack.Screen name="DashboardMain" component={OwnerDashboardScreen} /></Stack.Navigator>; }
function AdminStack()      { return <Stack.Navigator screenOptions={{ headerShown: false }}><Stack.Screen name="AdminMain" component={AdminScreen} /></Stack.Navigator>; }
function AccountsStack()   { return <Stack.Navigator screenOptions={{ headerShown: false }}><Stack.Screen name="AccountsMain" component={AccountsDashboardScreen} /></Stack.Navigator>; }
function DispatchStack()   { return <Stack.Navigator screenOptions={{ headerShown: false }}><Stack.Screen name="DispatchMain" component={DispatchDashboardScreen} /></Stack.Navigator>; }

// ─── Tab icons ──────────────────────────────────────────────────────────────
const TAB_ICONS = {
  Feed: '📋', Leaderboard: '🏆', 'My Stats': '📊',
  Dashboard: '📈', Admin: '⚙️', Accounts: '📑', Dispatch: '📦',
};

function NativeTabIcon({ label, focused }) {
  return (
    <Text style={{ fontSize: focused ? 22 : 20, opacity: focused ? 1 : 0.5 }}>
      {TAB_ICONS[label] || '📄'}
    </Text>
  );
}

const NATIVE_TAB_OPTS = {
  headerShown: false,
  tabBarActiveTintColor: COLORS.primary,
  tabBarInactiveTintColor: COLORS.textTertiary,
  tabBarLabelStyle: { fontFamily: 'Inter_600SemiBold', fontSize: 11 },
  tabBarStyle: {
    backgroundColor: COLORS.surface,
    borderTopColor: COLORS.border,
    borderTopWidth: 1,
    paddingTop: 4,
    height: 60,
  },
};

// ─── Web shell (top bar + collapsible sidebar) ──────────────────────────────
// The sidebar is rendered as the Tab.Navigator's `tabBar`. Its width is driven
// by `tabBarStyle` in screenOptions, which we toggle by passing a fresh
// `sidebarOpen` value via render-prop (`children(sidebarOpen)`).
function WebShell({ tabs, defaultTabName }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const { userName, logout } = useAuth();

  const handleLogout = () => {
    if (typeof window !== 'undefined' && window.confirm) {
      if (window.confirm('Log out of Sales Tracker?')) logout();
    } else {
      logout();
    }
  };

  return (
    <View style={webStyles.root}>
      {/* TOP BAR */}
      <View style={webStyles.topBar}>
        <TouchableOpacity
          onPress={() => setSidebarOpen((o) => !o)}
          style={webStyles.toggleBtn}
          accessibilityLabel={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          <Text style={webStyles.toggleIcon}>☰</Text>
        </TouchableOpacity>
        <Text style={webStyles.brand}>Sales Tracker</Text>
        <View style={{ flex: 1 }} />
        {userName ? (
          <Text style={webStyles.greeting}>Hi, {userName}</Text>
        ) : null}
        <TouchableOpacity onPress={handleLogout} style={webStyles.logoutBtn}>
          <Text style={webStyles.logoutText}>Log Out</Text>
        </TouchableOpacity>
      </View>

      {/* BODY: Tab.Navigator with custom sidebar tab bar */}
      <View style={{ flex: 1, flexDirection: 'row' }}>
        <Tab.Navigator
          tabBar={(props) =>
            sidebarOpen ? <WebSidebar {...props} /> : null
          }
          screenOptions={{
            headerShown: false,
            tabBarPosition: 'left',
            tabBarStyle: {
              width: sidebarOpen ? 240 : 0,
              backgroundColor: COLORS.surface,
              borderRightColor: COLORS.border,
              borderRightWidth: sidebarOpen ? 1 : 0,
              overflow: 'hidden',
            },
          }}
          initialRouteName={defaultTabName}
        >
          {tabs.map((tab) => (
            <Tab.Screen
              key={tab.name}
              name={tab.name}
              component={tab.component}
            />
          ))}
        </Tab.Navigator>
      </View>
    </View>
  );
}

// Custom sidebar rendered as `tabBar` of the Tab.Navigator. Receives the
// navigation state from React Navigation so we can highlight the active item
// and dispatch navigation when clicked.
function WebSidebar({ state, navigation }) {
  return (
    <View style={webStyles.sidebar}>
      {state.routes.map((route, index) => {
        const isFocused = state.index === index;
        const icon = TAB_ICONS[route.name] || '📄';

        return (
          <TouchableOpacity
            key={route.key}
            onPress={() => {
              const event = navigation.emit({
                type: 'tabPress',
                target: route.key,
                canPreventDefault: true,
              });
              if (!isFocused && !event.defaultPrevented) {
                navigation.navigate(route.name);
              }
            }}
            style={[webStyles.navItem, isFocused && webStyles.navItemActive]}
            activeOpacity={0.7}
          >
            <Text style={webStyles.navIcon}>{icon}</Text>
            <Text style={[webStyles.navLabel, isFocused && webStyles.navLabelActive]}>
              {route.name}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const webStyles = StyleSheet.create({
  root: { flex: 1, backgroundColor: COLORS.background },
  topBar: {
    height: 60,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    backgroundColor: COLORS.surface,
    borderBottomColor: COLORS.border,
    borderBottomWidth: 1,
  },
  toggleBtn: {
    width: 40, height: 40,
    borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 8,
  },
  toggleIcon: { fontSize: 20, color: COLORS.primary, fontFamily: 'Inter_600SemiBold' },
  brand: { fontSize: 17, fontFamily: 'Inter_700Bold', color: COLORS.primary },
  greeting: { fontSize: 14, fontFamily: 'Inter_500Medium', color: COLORS.textSecondary, marginRight: 12 },
  logoutBtn: {
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: COLORS.background,
    borderWidth: 1, borderColor: COLORS.border,
  },
  logoutText: { fontSize: 13, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary },
  sidebar: {
    width: 240,
    paddingTop: 16, paddingHorizontal: 12,
  },
  navItem: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 48,
    paddingHorizontal: 14,
    borderRadius: 12,
    marginBottom: 4,
  },
  navItemActive: { backgroundColor: COLORS.background },
  navIcon: { fontSize: 20, marginRight: 14, width: 24, textAlign: 'center' },
  navLabel: {
    fontSize: 14, fontFamily: 'Inter_600SemiBold', color: COLORS.textSecondary,
  },
  navLabelActive: { color: COLORS.primary },
});

// ─── Unknown-role fallback ──────────────────────────────────────────────────
function UnknownRoleScreen() {
  const { logout, userName } = useAuth();
  return (
    <View style={fallbackStyles.errorContainer}>
      <Text style={fallbackStyles.errorTitle}>Account Not Configured</Text>
      <Text style={fallbackStyles.errorBody}>
        {userName ? `Hi ${userName},` : 'Hi,'} your account doesn't have a valid role assigned.
        Please contact your administrator.
      </Text>
      <TouchableOpacity style={fallbackStyles.errorButton} onPress={() => logout()}>
        <Text style={fallbackStyles.errorButtonText}>Log Out</Text>
      </TouchableOpacity>
    </View>
  );
}
const fallbackStyles = StyleSheet.create({
  errorContainer: { flex: 1, padding: 24, paddingTop: SAFE_TOP + 80, backgroundColor: COLORS.background, alignItems: 'center' },
  errorTitle: { fontSize: 22, fontFamily: 'Inter_700Bold', color: COLORS.primary, marginBottom: 12, textAlign: 'center' },
  errorBody: { fontSize: 14, fontFamily: 'Inter_400Regular', color: COLORS.textSecondary, textAlign: 'center', marginBottom: 24, lineHeight: 20 },
  errorButton: { backgroundColor: COLORS.primary, borderRadius: 12, paddingVertical: 12, paddingHorizontal: 32 },
  errorButtonText: { color: COLORS.white, fontSize: 14, fontFamily: 'Inter_700Bold' },
});

// ─── Role → tabs table ──────────────────────────────────────────────────────
function getTabsForRole(role) {
  switch (role) {
    case ROLES.ACCOUNTS:
      return [{ name: 'Accounts', component: AccountsStack }];
    case ROLES.DISPATCH:
      return [{ name: 'Dispatch', component: DispatchStack }];
    case ROLES.OWNER:
      return [
        { name: 'Feed',        component: FeedStack },
        { name: 'Leaderboard', component: LeaderboardStack },
        { name: 'Dashboard',   component: DashboardStack },
        { name: 'Admin',       component: AdminStack },
      ];
    case ROLES.SALESPERSON:
      return [
        { name: 'Feed',        component: FeedStack },
        { name: 'Leaderboard', component: LeaderboardStack },
        { name: 'My Stats',    component: MyStatsStack },
      ];
    default:
      return null;
  }
}

// ─── Root navigator (the one App.js mounts) ─────────────────────────────────
export default function AppNavigator() {
  const { userRole } = useAuth();
  const tabs = getTabsForRole(userRole);

  if (!tabs) return <UnknownRoleScreen />;

  // Web: top bar + collapsible sidebar + content
  if (IS_WEB) {
    return <WebShell tabs={tabs} defaultTabName={tabs[0].name} />;
  }

  // Native: standard bottom tab bar
  return (
    <Tab.Navigator screenOptions={NATIVE_TAB_OPTS}>
      {tabs.map((tab) => (
        <Tab.Screen
          key={tab.name}
          name={tab.name}
          component={tab.component}
          options={{
            tabBarIcon: ({ focused }) => <NativeTabIcon label={tab.name} focused={focused} />,
          }}
        />
      ))}
    </Tab.Navigator>
  );
}
