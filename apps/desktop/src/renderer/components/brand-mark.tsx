import dark from "../../../../../assets/brand/web/vectis.svg";
import light from "../../../../../assets/brand/web/vectis-light.svg";

export function BrandMark({ className }: { className?: string }) {
  return (
    <picture className={className}>
      <source srcSet={dark} media="(prefers-color-scheme: dark)" />
      <img src={light} alt="" className="size-full" />
    </picture>
  );
}
