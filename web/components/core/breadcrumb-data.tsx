"use client";

import { usePathname } from "next/navigation";
import {
	createContext,
	useContext,
	useLayoutEffect,
	useCallback,
	useState,
	type ReactNode,
} from "react";

export type Breadcrumb = { label: string; href: string };

type BreadcrumbContextType = {
	breadcrumbs: Breadcrumb[];
	pathname: string;
	setBreadcrumbs: (breadcrumbs: Breadcrumb[], pathname: string) => void;
};

const BreadcrumbDataContext = createContext<BreadcrumbContextType>({
	breadcrumbs: [],
	pathname: "",
	setBreadcrumbs: () => {},
});

export function BreadcrumbDataProvider({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	const [state, setState] = useState<{ breadcrumbs: Breadcrumb[]; pathname: string }>({
		breadcrumbs: [],
		pathname: "",
	});

	const breadcrumbs = state.pathname === pathname ? state.breadcrumbs : [];

	const setBreadcrumbs = useCallback((newBreadcrumbs: Breadcrumb[], forPathname: string) => {
		setState({ breadcrumbs: newBreadcrumbs, pathname: forPathname });
	}, []);

	return (
		<BreadcrumbDataContext.Provider value={{ breadcrumbs, pathname, setBreadcrumbs }}>
			{children}
		</BreadcrumbDataContext.Provider>
	);
}

export function useBreadcrumbs() {
	return useContext(BreadcrumbDataContext).breadcrumbs;
}

export function SetBreadcrumbs({ items }: { items: Breadcrumb[] }) {
	const { setBreadcrumbs, pathname } = useContext(BreadcrumbDataContext);

	useLayoutEffect(() => {
		setBreadcrumbs(items, pathname);
	}, [items, setBreadcrumbs, pathname]);

	return null;
}
