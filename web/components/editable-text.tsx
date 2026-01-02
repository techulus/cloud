"use client";

import { Edit } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
	DialogFooter,
} from "@/components/ui/dialog";

export function EditableText({
	value,
	onChange,
	textClassName = "",
	type = "text",
	label,
}: {
	value: string;
	onChange: (value: string) => Promise<void> | void;
	textClassName?: string;
	type?: "text" | "number";
	label: string;
}) {
	const [isOpen, setIsOpen] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const [inputValue, setInputValue] = useState(value);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (isOpen) {
			setTimeout(() => {
				if (inputRef.current) {
					inputRef.current.focus();
					inputRef.current.select();
				}
			}, 50);
		}
	}, [isOpen]);

	const handleSave = useCallback(async () => {
		if (isSaving || inputValue === value) {
			setIsOpen(false);
			return;
		}
		setIsSaving(true);
		try {
			await onChange(inputValue);
			setIsOpen(false);
		} finally {
			setIsSaving(false);
		}
	}, [isSaving, onChange, inputValue, value]);

	const handleOpenChange = (open: boolean) => {
		setIsOpen(open);
		if (open) {
			setInputValue(value);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={handleOpenChange}>
			<DialogTrigger
				render={
					<button
						type="button"
						className={cn(
							"outline-none hover:bg-muted p-1 px-2 rounded-md -mx-2 group flex items-center gap-1",
							textClassName,
						)}
					/>
				}
			>
				<span>{value}</span>
				<Edit className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity ml-1" />
			</DialogTrigger>

			<DialogContent showCloseButton={false}>
				<DialogHeader>
					<DialogTitle>Update {label}</DialogTitle>
				</DialogHeader>

				<Input
					ref={inputRef}
					type={type}
					value={inputValue}
					onChange={(e) => setInputValue(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							handleSave();
						}
					}}
				/>

				<DialogFooter showCloseButton>
					<Button type="button" disabled={isSaving} onClick={handleSave}>
						{isSaving ? <Spinner /> : "Save"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
