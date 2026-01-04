"use client";

import {
	createContext,
	useContext,
	useEffect,
	useCallback,
	useState,
	type ReactNode,
} from "react";

export type Breadcrumb = { label: string; href: string };

type BreadcrumbContextType = {
	breadcrumbs: Breadcrumb[];
	setBreadcrumbs: (breadcrumbs: Breadcrumb[]) => void;
};

const BreadcrumbDataContext = createContext<BreadcrumbContextType>({
	breadcrumbs: [],
	setBreadcrumbs: () => {},
});

export function BreadcrumbDataProvider({ children }: { children: ReactNode }) {
	const [breadcrumbs, setBreadcrumbsState] = useState<Breadcrumb[]>([]);

	const setBreadcrumbs = useCallback((newBreadcrumbs: Breadcrumb[]) => {
		setBreadcrumbsState(newBreadcrumbs);
	}, []);

	return (
		<BreadcrumbDataContext.Provider value={{ breadcrumbs, setBreadcrumbs }}>
			{children}
		</BreadcrumbDataContext.Provider>
	);
}

export function useBreadcrumbs() {
	return useContext(BreadcrumbDataContext).breadcrumbs;
}

export function SetBreadcrumbs({ items }: { items: Breadcrumb[] }) {
	const { setBreadcrumbs } = useContext(BreadcrumbDataContext);

	useEffect(() => {
		setBreadcrumbs(items);
		return () => setBreadcrumbs([]);
	}, [items, setBreadcrumbs]);

	return null;
}
