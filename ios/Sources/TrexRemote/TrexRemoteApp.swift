import SwiftUI
import TrexRemoteCore
import UIKit
import UserNotifications

@main
struct TrexRemoteApp: App {
    @State private var model = AppModel()
    @UIApplicationDelegateAdaptor private var delegate: AppDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
        }
    }
}

/// Muestra los avisos también con la app abierta (iOS los oculta por defecto).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let palette = model.palette
        Group {
            if model.servers.isEmpty {
                PairView()
            } else {
                MainTabs()
            }
        }
        .environment(\.palette, palette)
        .tint(palette.accent)
        .preferredColorScheme(palette.isDark ? .dark : .light)
        .overlay(alignment: .bottom) {
            ToastOverlay().environment(\.palette, palette)
        }
        .animation(.snappy, value: model.toast)
        .animation(.default, value: model.servers.isEmpty)
        .onChange(of: scenePhase) { _, phase in model.scenePhaseChanged(phase) }
    }
}

private struct MainTabs: View {
    @Environment(AppModel.self) private var model
    @Environment(\.palette) private var palette

    private enum Tab: Hashable { case sessions, waiting, device }
    @State private var tab = Tab.sessions
    @State private var sessionsPath: [String] = []
    @State private var waitingPath: [String] = []

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack(path: $sessionsPath) {
                SessionListView(onlyWaiting: false) { tab = .waiting }
                    .navigationDestination(for: String.self) { ChatView(sessionID: $0) }
            }
            .tabItem { Label("Sesiones", systemImage: "list.bullet") }
            .tag(Tab.sessions)

            NavigationStack(path: $waitingPath) {
                SessionListView(onlyWaiting: true)
                    .navigationDestination(for: String.self) { ChatView(sessionID: $0) }
            }
            .tabItem { Label("Esperan", systemImage: "exclamationmark.triangle") }
            .badge(model.waitingCount)
            .tag(Tab.waiting)

            NavigationStack {
                DeviceView()
            }
            .tabItem { Label("Este iPhone", systemImage: "iphone") }
            .tag(Tab.device)
        }
        .toolbarBackground(palette.sidebar, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
        // Al cambiar de trex, el chat abierto era del otro PC: se vuelve a las listas.
        .onChange(of: model.activeID) { _, _ in
            sessionsPath = []
            waitingPath = []
        }
        // Un chat recién abierto desde el iPhone se muestra al momento.
        .onChange(of: model.openedSession) { _, session in
            guard let session else { return }
            tab = .sessions
            sessionsPath = [session]
            model.openedSession = nil
        }
        .sheet(item: Binding(get: { model.newChat }, set: { model.newChat = $0 })) { request in
            if let catalog = model.catalog {
                NewChatSheet(request: request, catalog: catalog,
                             visibleProjects: ProjectListing.groups(catalog: catalog, sessions: model.sessions, filter: model.projectFilter).map(\.id))
                    .environment(model)
                    .environment(\.palette, palette)
                    .tint(palette.accent)
                    .presentationDetents([.large])
                    .presentationBackground(palette.elevated)
            }
        }
        .sheet(isPresented: Binding(get: { model.showPairing }, set: { model.showPairing = $0 })) {
            PairView(adding: true)
                .environment(model)
                .environment(\.palette, palette)
                .tint(palette.accent)
                .presentationBackground(palette.app)
        }
    }
}
