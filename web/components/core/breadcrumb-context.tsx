"use client";

import {
	createContext,
	useContext,
	useState,
	useCallback,
	type ReactNode,
} from "react";

type Breadcrumb = {
	label: string;
	href?: string;
};

type BreadcrumbContextType = {
	breadcrumbs: Breadcrumb[];
	title: ReactNode;
	setBreadcrumbs: (breadcrumbs: Breadcrumb[], title: ReactNode) => void;
	clearBreadcrumbs: () => void;
};

const BreadcrumbContext = createContext<BreadcrumbContextType | null>(null);

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
	const [breadcrumbs, setBreadcrumbsState] = useState<Breadcrumb[]>([]);
	const [title, setTitle] = useState<ReactNode>(null);

	const setBreadcrumbs = useCallback((crumbs: Breadcrumb[], t: ReactNode) => {
		setBreadcrumbsState(crumbs);
		setTitle(t);
	}, []);

	const clearBreadcrumbs = useCallback(() => {
		setBreadcrumbsState([]);
		setTitle(null);
	}, []);

	return (
		<BreadcrumbContext.Provider
			value={{ breadcrumbs, title, setBreadcrumbs, clearBreadcrumbs }}
		>
			{children}
		</BreadcrumbContext.Provider>
	);
}

export function useBreadcrumbs() {
	const context = useContext(BreadcrumbContext);
	if (!context) {
		throw new Error("useBreadcrumbs must be used within a BreadcrumbProvider");
	}
	return context;
}
