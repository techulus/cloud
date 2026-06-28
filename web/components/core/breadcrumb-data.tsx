"use client";

import { usePathname } from "next/navigation";
import {
	createContext,
	type ReactNode,
	use,
	useCallback,
	useLayoutEffect,
	useMemo,
	useState,
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

const EMPTY_BREADCRUMBS: Breadcrumb[] = [];

export function BreadcrumbDataProvider({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	const [state, setState] = useState<{
		breadcrumbs: Breadcrumb[];
		pathname: string;
	}>({
		breadcrumbs: [],
		pathname: "",
	});

	const breadcrumbs =
		state.pathname === pathname ? state.breadcrumbs : EMPTY_BREADCRUMBS;

	const setBreadcrumbs = useCallback(
		(newBreadcrumbs: Breadcrumb[], forPathname: string) => {
			setState({ breadcrumbs: newBreadcrumbs, pathname: forPathname });
		},
		[],
	);

	const value = useMemo(
		() => ({ breadcrumbs, pathname, setBreadcrumbs }),
		[breadcrumbs, pathname, setBreadcrumbs],
	);

	return (
		<BreadcrumbDataContext.Provider value={value}>
			{children}
		</BreadcrumbDataContext.Provider>
	);
}

export function useBreadcrumbs() {
	return use(BreadcrumbDataContext).breadcrumbs;
}

export function SetBreadcrumbs({ items }: { items: Breadcrumb[] }) {
	const { setBreadcrumbs, pathname } = use(BreadcrumbDataContext);

	useLayoutEffect(() => {
		setBreadcrumbs(items, pathname);
	}, [items, setBreadcrumbs, pathname]);

	return null;
}
