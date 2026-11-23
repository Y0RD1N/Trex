import Foundation

/// Qué proyectos se ven en el iPhone: todos, los favoritos del PC o una selección propia.
/// Es del iPhone (se guarda por cada trex): ocultar algo aquí no cambia la barra lateral del PC.
public struct ProjectFilter: Codable, Hashable, Sendable {
    public enum Mode: String, Codable, Sendable, CaseIterable {
        case all, favorites, selected
    }

    public var mode: Mode
    /// Los proyectos elegidos en el modo `selected`.
    public var selected: Set<String>

    public init(mode: Mode = .all, selected: Set<String> = []) {
        self.mode = mode
        self.selected = selected
    }

    public static let all = ProjectFilter()

    public func shows(_ project: RemoteCatalog.Project) -> Bool {
        switch mode {
        case .all: true
        case .favorites: project.favorite
        case .selected: selected.contains(project.id)
        }
    }

    /// Oculta un proyecto: pasa a «mi selección» con todos los que se veían menos ese.
    public func hiding(_ id: String, among projects: [RemoteCatalog.Project]) -> ProjectFilter {
        let visible = projects.filter(shows).map(\.id)
        return ProjectFilter(mode: .selected, selected: Set(visible).subtracting([id]))
    }

    public func toggling(_ id: String) -> ProjectFilter {
        var next = self
        next.mode = .selected
        if next.selected.contains(id) { next.selected.remove(id) } else { next.selected.insert(id) }
        return next
    }
}

/// Un proyecto de la lista con sus chats abiertos.
public struct ProjectGroup: Hashable, Sendable, Identifiable {
    public var project: RemoteProject
    public var favorite: Bool
    public var sessions: [RemoteSession]

    public var id: String { project.id }
    public var needs: Int { sessions.filter { $0.status == .needs }.count }
    public var busy: Bool { sessions.contains { $0.status == .working } }
}

public enum ProjectListing {
    /// Los proyectos para la lista, en el orden de la barra lateral del PC.
    ///
    /// Con catálogo salen todos los que deja ver el filtro (también sin chats) y, siempre,
    /// los que tienen algo que te espera: un permiso pendiente no se esconde. Sin catálogo
    /// (un trex anterior) solo los que tienen chats abiertos, como antes.
    /// `onlyWaiting`: solo lo que te espera, sin filtro.
    public static func groups(
        catalog: RemoteCatalog?, sessions: [RemoteSession], filter: ProjectFilter, onlyWaiting: Bool = false
    ) -> [ProjectGroup] {
        var byProject: [String: ProjectGroup] = [:]
        for session in sessions where !onlyWaiting || session.status == .needs {
            byProject[session.project.id, default: ProjectGroup(project: session.project, favorite: false, sessions: [])].sessions.append(session)
        }
        var groups: [ProjectGroup] = []
        if let catalog, !onlyWaiting {
            for project in catalog.projects {
                var group = byProject.removeValue(forKey: project.id) ?? ProjectGroup(project: project.asProject, favorite: project.favorite, sessions: [])
                group.project = project.asProject
                group.favorite = project.favorite
                guard filter.shows(project) || group.needs > 0 else { continue }
                groups.append(group)
            }
            // Chats de proyectos que el catálogo aún no conoce: mejor verlos que perderlos.
            groups.append(contentsOf: byProject.values)
        } else {
            let favorites = Set(catalog?.projects.filter(\.favorite).map(\.id) ?? [])
            groups = byProject.values.map { group in
                var group = group
                group.favorite = favorites.contains(group.id)
                return group
            }
        }
        return groups
            .map { group in
                var group = group
                group.sessions.sort { ($0.status.rank, -$0.updatedAt) < ($1.status.rank, -$1.updatedAt) }
                return group
            }
            .sorted { lhs, rhs in
                let left = lhs.project.order ?? .greatestFiniteMagnitude
                let right = rhs.project.order ?? .greatestFiniteMagnitude
                return left != right ? left < right : lhs.project.name.lowercased() < rhs.project.name.lowercased()
            }
    }
}
